"""Loopback-only System One bridge to the real, non-generative this-that model."""

import argparse
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODEL_ID = "flock-io/this-that-model-1.2"
MODEL_REVISION = "c4d1c30b8d512d278726de439b8cc81fccc70c8f"
DEFAULT_MODEL_PATH = Path(__file__).parent / "models" / "this-that-model-1.2"
MAX_BODY_BYTES = 65536
MAX_STATE_TOKENS = 4096
MAX_PROMPT_TOKENS = 8192


class RequestError(ValueError):
    pass


def prepare(body, tokenizer):
    from thisthat.prompt import build
    from thisthat.systemone_protocol import SystemOneRequestError, parse_request

    try:
        state, typed = parse_request(body)
    except SystemOneRequestError as error:
        raise RequestError(str(error)) from error
    if len(typed) > 16:
        raise RequestError("At most 16 questions are supported.")
    if len(tokenizer.encode("Context:\n" + state, add_special_tokens=False)) > MAX_STATE_TOKENS + 3:
        raise RequestError("State exceeds the token limit; refusing to truncate it.")
    questions = [item.question for item in typed]
    prompt = build(tokenizer, state, questions, max_state_tokens=MAX_STATE_TOKENS)
    if len(prompt["ids"]) > MAX_PROMPT_TOKENS:
        raise RequestError("Prompt exceeds the token limit; refusing to truncate it.")
    return state, typed, len(prompt["ids"])


def infer(decider, prepared):
    from thisthat.systemone_protocol import render_answer

    state, typed, tokens = prepared
    started = time.perf_counter()
    decisions = decider.decide(
        state,
        [item.question for item in typed],
        temperature=1.0,
        max_state_tokens=MAX_STATE_TOKENS,
    )
    if len(decisions) != len(typed):
        raise RuntimeError("Model returned the wrong number of decisions.")
    answers = {}
    for question, decision in zip(typed, decisions, strict=True):
        if tuple(decision.options) != question.labels:
            raise RuntimeError("Model changed the declared option order.")
        answer = render_answer(question, decision)
        if question.type == "choice":
            answer["confidence"] = decision.confidence
        answers[question.key] = answer
    return {
        "engine": "this-that",
        "model": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "device": str(decider.device),
        "answers": answers,
        "usage": {"input_tokens": tokens, "output_tokens": 0},
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def create_server(decider, port):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, status, value):
            data = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                self.log_error("Client disconnected before the response was delivered.")

        def local_request(self):
            expected = f"127.0.0.1:{self.server.server_port}"
            if (
                self.headers.get("Host") != expected
                or self.headers.get("Origin", f"http://{expected}") != f"http://{expected}"
                or self.headers.get("Sec-Fetch-Site") == "cross-site"
            ):
                self.reply(403, {"error": "Only same-origin numeric loopback requests are allowed."})
                return False
            return True

        def do_GET(self):
            if not self.local_request():
                return
            if self.path != "/health":
                self.reply(404, {"error": "Not found."})
                return
            self.reply(200, {
                "ready": True, "engine": "this-that", "model": MODEL_ID,
                "modelRevision": MODEL_REVISION, "device": str(self.server.decider.device),
            })

        def do_POST(self):
            if not self.local_request():
                return
            if self.path != "/v1/systemone":
                self.reply(404, {"error": "Not found."})
                return
            try:
                if self.headers.get_content_type() != "application/json":
                    raise RequestError("Decisions require application/json.")
                if self.headers.get("Transfer-Encoding"):
                    raise RequestError("Chunked requests are not supported.")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY_BYTES:
                    raise RequestError(f"Request must contain 1..{MAX_BODY_BYTES} bytes.")
                data = self.rfile.read(length)
                if len(data) != length:
                    raise RequestError("Incomplete request body.")
                prepared = prepare(json.loads(data), self.server.decider.tokenizer)
            except (ValueError, UnicodeDecodeError, TimeoutError) as error:
                self.log_error("Invalid decision request: %s", error)
                self.reply(400, {"error": str(error)})
                return
            try:
                self.reply(200, infer(self.server.decider, prepared))
            except (RuntimeError, ValueError, OSError) as error:
                traceback.print_exc()
                self.reply(500, {"error": f"Local model inference failed: {error}"})

    # One model call at a time, in the serving thread; no concurrent MLX forwards.
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.decider = decider
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")
    if not (args.model_path / "model.safetensors").is_file():
        parser.error("Local checkpoint missing. Run: pnpm download:model")
    source = args.model_path / "source.json"
    if not source.is_file() or json.loads(source.read_text()) != {
        "model": MODEL_ID, "revision": MODEL_REVISION,
    }:
        parser.error("Checkpoint provenance is missing or mismatched. Run: pnpm download:model")

    # Reserve the port before allocating weights, so a duplicate launch fails cheaply.
    with create_server(None, args.port) as server:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        from thisthat import Question, TypedDecider

        print(f"Loading {MODEL_ID} from {args.model_path} (offline)...", flush=True)
        decider = TypedDecider.from_pretrained(str(args.model_path.resolve()), device="auto")
        decider.decide("direction=right", Question("Which direction?", ["left", "right"]))
        server.decider = decider
        print(f"Ready: http://127.0.0.1:{args.port} | {decider.device}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Stopping local decision service.", file=sys.stderr)


if __name__ == "__main__":
    main()
