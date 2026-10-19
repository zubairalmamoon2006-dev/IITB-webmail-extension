# Local embedding runtime

These files run the all-MiniLM-L6-v2 model inside the extension (offscreen.js),
so mail search never sends mail text anywhere.

| File | From | Licence |
|---|---|---|
| ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs, ort-wasm-simd-threaded.wasm | npm `onnxruntime-web@1.30.0` (Microsoft) | MIT |
| tokenizers.min.mjs | npm `@huggingface/tokenizers@0.2.0` | Apache-2.0 (LICENSE-tokenizers.txt) |

To update: `npm install onnxruntime-web@<version> @huggingface/tokenizers@<version>`
and copy the same files from their `dist/` folders.
