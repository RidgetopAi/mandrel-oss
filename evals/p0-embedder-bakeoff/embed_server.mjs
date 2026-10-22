#!/usr/bin/env node
/**
 * P0 embed_server.mjs — the incumbent-floor encoder (MiniLM-L6), reconstructed
 * from RUN_CONFIG.md. Loads the SAME @xenova model file + SAME pooling as
 * Mandrel's localModel.ts ({pooling:'mean', normalize:true}), native 384-dim,
 * fully OFFLINE (allowRemoteModels=false). Batch /embed endpoint.
 *
 * Launch:  node embed_server.mjs        (reads EMBED_PORT, default 8390)
 *   /health          -> {ok, model, dim}
 *   POST /embed {texts:[...]} -> {embeddings:[[...],...], dim}
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(HERE, '../../mcp-server');   // this checkout's mcp-server
// The model folder Mandrel ships (vendor/models/Xenova/all-MiniLM-L6-v2); overridable for tests.
export const MODEL_DIR = process.env.EMBED_MODEL_DIR || path.join(MCP_SERVER, 'vendor', 'models');

// --print-model-dir: report the resolved model folder and exit (no model load) — used by the test.
if (process.argv.includes('--print-model-dir')) {
  console.log(MODEL_DIR);
  process.exit(0);
}

// Resolve @xenova/transformers from mcp-server's node_modules (run `npm ci` there first).
const { pipeline, env } = await import(pathToFileURL(
  path.join(MCP_SERVER, 'node_modules/@xenova/transformers/src/transformers.js')).href);
env.allowRemoteModels = false;               // offline: use the vendored ONNX only
env.cacheDir = MODEL_DIR;
env.localModelPath = MODEL_DIR;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const PORT = parseInt(process.env.EMBED_PORT || '8390', 10);

console.error(`[embed_server] loading ${MODEL} (offline) ...`);
const extractor = await pipeline('feature-extraction', MODEL);
// probe dim
const probe = await extractor('probe', { pooling: 'mean', normalize: true });
const DIM = probe.data.length;
console.error(`[embed_server] ready: dim=${DIM} on :${PORT}`);

async function embedOne(text) {
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: MODEL, dim: DIM }));
    return;
  }
  if (req.method === 'POST' && req.url === '/embed') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { texts } = JSON.parse(body);
        const embeddings = [];
        for (const t of texts) embeddings.push(await embedOne(t ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embeddings, dim: DIM }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(PORT, '127.0.0.1');
