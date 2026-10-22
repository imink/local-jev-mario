"""Explicit setup-time download; gameplay never downloads or calls a remote model."""

import json
from pathlib import Path

from huggingface_hub import snapshot_download

from local_this_that import DEFAULT_MODEL_PATH, MODEL_ID, MODEL_REVISION


if __name__ == "__main__":
    path = snapshot_download(
        MODEL_ID,
        revision=MODEL_REVISION,
        token=False,
        local_dir=DEFAULT_MODEL_PATH,
        allow_patterns=[
            "*.json", "*.safetensors", "*.jinja", "README.md", "LICENSE*",
        ],
    )
    (Path(path) / "source.json").write_text(
        json.dumps({"model": MODEL_ID, "revision": MODEL_REVISION}) + "\n"
    )
    print(f"Downloaded {MODEL_ID}@{MODEL_REVISION} to {path}")
