#!/usr/bin/env bash
# Downloads the all-MiniLM-L6-v2 files (about 23 MB) from Hugging Face into
# extension/models/all-MiniLM-L6-v2/. Run once before loading the extension.
# Without them the extension downloads the same files on first use instead.
set -euo pipefail
cd "$(dirname "$0")"
BASE="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main"
DEST="all-MiniLM-L6-v2"
mkdir -p "$DEST/onnx"
for f in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
  echo "Downloading $f"
  curl -fL --retry 3 -o "$DEST/$f" "$BASE/$f"
done
echo "Done. Model files are in extension/models/$DEST"
