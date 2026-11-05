import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createEditorRelay, createRelayHttpHandler } from './relay.mjs';
import { registerEditorTools } from './editor-tools.mjs';
import { registerVideoEditorTools } from './video-editor-tools.mjs';
import { boundToolOutput } from './bounded-output.mjs';
import { resolveVideoHostAsset } from './video-host-route.mjs';

const hostRoot = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(hostRoot, '../miniPaint/miniPaint-master');
const relay = createEditorRelay({ editorKind: 'image' });
const videoRelay = createEditorRelay({ editorKind: 'video', allowedTypes: ['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status'] });
const videoRoot = resolve(hostRoot, '../video');
const token = randomBytes(32).toString('hex');
const tools = new Map();
const videoTools = new Map();
// Explicitly a local harness registry, NOT the DSH runtime registry.
registerEditorTools({ tools: { register: (tool) => tools.set(tool.name, tool) }, defineTool: (tool) => tool, transport: relay });
registerVideoEditorTools({ tools: { register: (tool) => videoTools.set(tool.name, tool) }, defineTool: (tool) => tool, transport: videoRelay });
let origin;
let relayHandler;
let videoRelayHandler;
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > 32768) throw new Error('Request too large'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function serve(res, root, name) {
  const canonicalRoot = await realpath(root);
  const path = await realpath(resolve(root, name));
  const rel = relative(canonicalRoot, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(canonicalRoot, rel) !== path || !(await stat(path)).isFile()) { json(res, 404, { error: 'Not found' }); return; }
  const bytes = await readFile(path);
  res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(bytes);
}
const server = createServer((req, res) => void (async () => {
  try {
    if (req.headers.host !== new URL(origin).host) { json(res, 403, { error: 'Host rejected' }); return; }
    if (await relayHandler(req, res)) return;
    if (await videoRelayHandler(req, res)) return;
    const url = new URL(req.url, origin);
    if (url.pathname === '/health') { json(res, 200, { ok: true, mode: 'isolated-prototype', registry: 'local-harness-not-DSH', editorPath: '/editor/' }); return; }
    if (url.pathname === '/prototype-tools' || url.pathname === '/video-tools') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers.authorization !== `Bearer ${token}` || req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 403, { error: 'Authentication required' }); return; }
      const { name, args } = await body(req);
      const registry = url.pathname === '/video-tools' ? videoTools : tools;
      const tool = registry.get(name);
      if (!tool) { json(res, 400, { code: 'INVALID_REQUEST', message: 'Unknown tool' }); return; }
      try { json(res, 200, boundToolOutput({ ok: true, result: await tool.execute(args) }, { name, commandId: args?.commandId })); }
      catch (error) { json(res, 200, boundToolOutput({ ok: false, error: { code: error.code || 'EDITOR_ERROR', message: error.message, revision: error.revision, commandId: error.commandId, outcomeUnknown: error.outcomeUnknown } }, { name, commandId: args?.commandId })); }
      return;
    }
    if (req.method !== 'GET') { json(res, 405, { error: 'GET required' }); return; }
    if (url.pathname === '/boot') {
      if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty') { json(res, 403, { error: 'Same-origin fetch required' }); return; }
      json(res, 200, { accessToken: token }); return;
    }
    if (url.pathname === '/') { await serve(res, hostRoot, 'prototype-parent.html'); return; }
    const modules = new Set(['/host/iframe-transport.mjs', '/host/browser-relay.mjs', '/host/prototype-parent.mjs']);
    if (modules.has(url.pathname)) { await serve(res, hostRoot, url.pathname.slice('/host/'.length)); return; }
    if (url.pathname === '/editor') { res.writeHead(302, { Location: '/editor/' }); res.end(); return; }
    if (url.pathname === '/video') { res.writeHead(302, { Location: '/video/' }); res.end(); return; }
    if (url.pathname === '/video/' || url.pathname.startsWith('/video/')) {
      const name = decodeURIComponent(url.pathname.slice('/video/'.length)) || 'index.html';
      if (name.includes('..') || name.endsWith('.map') || !/^[a-zA-Z0-9._/-]+$/.test(name)) { json(res, 404, { error: 'Not found' }); return; }
      await serve(res, videoRoot, name); return;
    }
    // Local harness wrapper for the video plugin: /video-host/ serves video/host.html plus its
    // relative assets (host.js) from the same isolated video subtree. Not a DSH runtime entry.
    if (url.pathname === '/video-host' || url.pathname.startsWith('/video-host/')) {
      const route = resolveVideoHostAsset(url.pathname);
      if (route?.redirect) { res.writeHead(302, { Location: route.redirect }); res.end(); return; }
      if (!route?.asset) { json(res, 404, { error: 'Not found' }); return; }
      await serve(res, videoRoot, route.asset); return;
    }
    if (url.pathname.startsWith('/editor/')) {
      const name = decodeURIComponent(url.pathname.slice('/editor/'.length)) || 'index.html';
      // Only publish editor runtime assets, never source, lockfiles or node_modules.
      if (!(name === 'index.html' || /^(dist|css|images|fonts|languages|vendor)\//.test(name)) || name.includes('..') || name.endsWith('.map')) { json(res, 404, { error: 'Not found' }); return; }
      await serve(res, editorRoot, name); return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) json(res, 500, { error: 'Prototype request failed', code: error.code || 'SERVER_ERROR' }); else res.end(); }
})());
server.requestTimeout = 15000;
server.headersTimeout = 10000;
await new Promise((resolve) => server.listen(Number(process.env.PROTOTYPE_PORT || 0), '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
relayHandler = createRelayHttpHandler({ relay, origin, accessToken: token, prefix: '/editor-relay' });
videoRelayHandler = createRelayHttpHandler({ relay: videoRelay, origin, accessToken: token, prefix: '/video-relay' });
console.log(JSON.stringify({ mode: 'isolated-prototype-not-DSH', url: `${origin}/`, health: `${origin}/health`, pid: process.pid }));
function stop() { relay.close(); videoRelay.close(); server.close(); server.closeAllConnections(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
