// Runs the all-MiniLM-L6-v2 embedding model inside the extension. The
// background worker sends texts here and gets back 384-number vectors.
// Nothing leaves the laptop: the model files are bundled in models/ (or, if
// they were not bundled, downloaded once from Hugging Face and cached).
import * as ort from "./embed/ort.wasm.min.mjs";
import { Tokenizer } from "./embed/tokenizers.min.mjs";

const MODEL_ID = "all-MiniLM-L6-v2-q8";
const MAX_TOKENS = 128;
const MAX_INPUT_CHARS = 2000;
const LOCAL_BASE = chrome.runtime.getURL("models/all-MiniLM-L6-v2/");
const REMOTE_BASE = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/";
const MODEL_CACHE = "mail-iitb-embedding-model";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = chrome.runtime.getURL("embed/");

let modelPromise = null;

async function fetchLocal(path) {
  const response = await fetch(LOCAL_BASE + path);
  if (!response.ok) throw new Error(`missing ${path}`);
  return response;
}

async function fetchRemoteCached(path) {
  const url = REMOTE_BASE + path;
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(url);
  if (hit) return hit;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the search model (${response.status}).`);
  await cache.put(url, response.clone());
  return response;
}

async function fetchModelFile(path) {
  try {
    return await fetchLocal(path);
  } catch (err) {
    return fetchRemoteCached(path);
  }
}

function loadModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const [tokenizerJson, tokenizerConfig, modelBytes] = await Promise.all([
      fetchModelFile("tokenizer.json").then((r) => r.json()),
      fetchModelFile("tokenizer_config.json").then((r) => r.json()),
      fetchModelFile("onnx/model_quantized.onnx").then((r) => r.arrayBuffer()),
    ]);
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["wasm"],
    });
    return { tokenizer, session };
  })();
  modelPromise.catch(() => {
    modelPromise = null; // allow a retry next time
  });
  return modelPromise;
}

async function embed(texts) {
  const { tokenizer, session } = await loadModel();
  const encoded = texts.map((text) => tokenizer.encode(String(text || " ").slice(0, MAX_INPUT_CHARS)));
  const length = Math.min(MAX_TOKENS, Math.max(...encoded.map((e) => e.ids.length)));
  const count = texts.length;
  const ids = new BigInt64Array(count * length);
  const mask = new BigInt64Array(count * length);
  const types = new BigInt64Array(count * length);

  encoded.forEach((e, row) => {
    const n = Math.min(length, e.ids.length);
    for (let j = 0; j < n; j++) {
      ids[row * length + j] = BigInt(e.ids[j]);
      mask[row * length + j] = 1n;
    }
    if (e.ids.length > length) ids[row * length + length - 1] = BigInt(e.ids[e.ids.length - 1]); // keep [SEP]
  });

  const feeds = {
    input_ids: new ort.Tensor("int64", ids, [count, length]),
    attention_mask: new ort.Tensor("int64", mask, [count, length]),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", types, [count, length]);
  }

  const output = (await session.run(feeds))[session.outputNames[0]];
  const hidden = output.dims[2];
  const data = output.data;
  const vectors = [];

  // Mean pooling over real tokens, then L2-normalise (what sentence-transformers does).
  for (let row = 0; row < count; row++) {
    const vec = new Float32Array(hidden);
    let tokens = 0;
    for (let j = 0; j < length; j++) {
      if (!mask[row * length + j]) continue;
      tokens++;
      const offset = (row * length + j) * hidden;
      for (let h = 0; h < hidden; h++) vec[h] += data[offset + h];
    }
    let norm = 0;
    for (let h = 0; h < hidden; h++) {
      vec[h] /= Math.max(tokens, 1);
      norm += vec[h] * vec[h];
    }
    norm = Math.sqrt(norm) || 1;
    for (let h = 0; h < hidden; h++) vec[h] /= norm;
    vectors.push(Array.from(vec));
  }
  return vectors;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;

  if (message.type === "EMBED") {
    embed(Array.isArray(message.texts) ? message.texts : [])
      .then((vectors) => sendResponse({ ok: true, vectors, model: MODEL_ID }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (message.type === "PING") {
    sendResponse({ ok: true, model: MODEL_ID });
    return false;
  }
  return false;
});
