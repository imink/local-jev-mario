import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from thisthat.types import Decision

from local_this_that import (
    MAX_BODY_BYTES,
    MAX_PROMPT_TOKENS,
    MAX_STATE_TOKENS,
    MODEL_ID,
    MODEL_REVISION,
    RequestError,
    create_server,
    infer,
    prepare,
)

ACTIONS = ("noop", "right", "right_jump", "right_run", "right_run_jump", "jump", "left", "down", "left_jump")


def request():
    return {
        "state": {"player": {"x": 40}, "experience": None},
        "questions": {
            "move": {
                "type": "choice",
                "instructions": "Choose a controller action.",
                "criteria": {action: f"Description for {action}" for action in ACTIONS},
            },
            "jump_needed": {"type": "noul", "instructions": "Is a jump useful now?"},
        },
    }


class Tokenizer:
    def encode(self, text, **kwargs):
        return list(text.encode())


class FakeDecider:
    """Protocol double only: never used by the real application."""

    tokenizer = Tokenizer()
    device = "test-double"

    def __init__(self):
        self.calls = []
        self.failure = None

    def decide(self, state, questions, **kwargs):
        self.calls.append((state, questions, kwargs))
        if self.failure:
            raise self.failure
        return [
            Decision(q.text, q.options, q.options.index("right_jump"),
                     tuple(0.7 if item == "right_jump" else 0.3 / (len(ACTIONS) - 1) for item in q.options))
            if tuple(q.options) == ACTIONS else Decision(q.text, q.options, 1, (0.2, 0.8))
            for q in questions
        ]


class DecisionTests(unittest.TestCase):
    def test_option_order_probabilities_noul_and_single_pass(self):
        model = FakeDecider()
        prepared = prepare(request(), model.tokenizer)
        result = infer(model, prepared)
        self.assertEqual(len(model.calls), 1)
        state, questions, options = model.calls[0]
        self.assertEqual(json.loads(state)["experience"], None)
        self.assertEqual(tuple(questions[0].options), ACTIONS)
        self.assertEqual(tuple(questions[1].options), ("no", "yes"))
        self.assertIn("Description for right_jump", questions[0].text)
        self.assertEqual(options, {"temperature": 1.0, "max_state_tokens": MAX_STATE_TOKENS})
        self.assertEqual(result["answers"]["move"]["choice"], "right_jump")
        self.assertEqual(list(result["answers"]["move"]["probabilities"]), list(ACTIONS))
        self.assertEqual(result["answers"]["move"]["confidence"], 0.7)
        self.assertEqual(result["answers"]["jump_needed"]["noul"], 0.8)
        self.assertEqual(result["usage"]["input_tokens"], prepared[2])
        self.assertEqual(result["usage"]["output_tokens"], 0)

    def test_no_silent_state_or_prompt_truncation(self):
        body = request()
        body["state"] = "x" * (MAX_STATE_TOKENS + 1)
        with self.assertRaisesRegex(RequestError, "refusing to truncate"):
            prepare(body, Tokenizer())
        body = request()
        body["questions"]["move"]["instructions"] = "x" * MAX_PROMPT_TOKENS
        with self.assertRaisesRegex(RequestError, "refusing to truncate"):
            prepare(body, Tokenizer())

    def test_invalid_question_and_unbounded_question_count(self):
        body = request()
        body["questions"]["move"]["type"] = "box"
        with self.assertRaises(RequestError):
            prepare(body, Tokenizer())
        body["questions"] = {
            str(i): {"type": "noul", "instructions": "A question?"} for i in range(17)
        }
        with self.assertRaisesRegex(RequestError, "16 questions"):
            prepare(body, Tokenizer())


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeDecider()
        self.server = create_server(self.model, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.shutdown)

    def send(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_and_actual_http_protocol(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, health = self.send("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ready"])
        self.assertEqual(health["model"], MODEL_ID)
        status, result = self.send("POST", "/v1/systemone", json.dumps(request()),
                                   {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result["answers"]["move"]["choice"], "right_jump")
        self.assertEqual(len(self.model.calls), 1)

    def test_host_origin_content_type_and_body_limits(self):
        for headers in [
            {"Host": "rebound.example"},
            {"Origin": "https://remote.example"},
            {"Sec-Fetch-Site": "cross-site"},
        ]:
            status, _ = self.send("GET", "/health", headers=headers)
            self.assertEqual(status, 403)
        for body, headers in [
            (json.dumps(request()), {"Content-Type": "text/plain"}),
            ("{", {"Content-Type": "application/json"}),
            ("x" * (MAX_BODY_BYTES + 1), {"Content-Type": "application/json"}),
        ]:
            status, _ = self.send("POST", "/v1/systemone", body, headers)
            self.assertEqual(status, 400)
        self.assertEqual(self.model.calls, [])

    def test_inference_failure_is_an_error_not_an_action(self):
        self.model.failure = RuntimeError("test inference failure")
        status, result = self.send("POST", "/v1/systemone", json.dumps(request()),
                                   {"Content-Type": "application/json"})
        self.assertEqual(status, 500)
        self.assertIn("test inference failure", result["error"])
        self.assertNotIn("answers", result)

    def test_duplicate_launch_fails_before_loading_any_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.safetensors").touch()
            (root / "source.json").write_text(
                json.dumps({"model": MODEL_ID, "revision": MODEL_REVISION})
            )
            result = subprocess.run(
                [sys.executable, str(Path(__file__).parents[1] / "local_this_that.py"),
                 "--model-path", directory, "--port", str(self.server.server_port)],
                capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Address already in use", result.stderr)
            self.assertNotIn("Loading", result.stdout)


if __name__ == "__main__":
    unittest.main()
