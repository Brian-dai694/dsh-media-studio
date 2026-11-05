import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEditorRelay, createRelayHttpHandler } from './relay.mjs';
import { startBrowserRelay } from './browser-relay.mjs';
import { createEditorBridge } from './editor-tools.mjs';
import { boundToolOutput } from './bounded-output.mjs';

const message = (id = 'r1') => ({ type: 'editor.apply_command', requestId: id, editorInstanceId: 'e1', commandId: 'c1' });

test('exact page binding rejects forged responses and correlates one reply', async () => {
  const relay = createEditorRelay({ minPollIntervalMs: 0 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    const other = relay.register({ editorInstanceId: 'e2' });
    const result = relay.request(message());
    assert.equal(relay.poll(page).messages.length, 1);
    assert.equal(relay.poll(page).messages.length, 0);
    assert.throws(() => relay.respond({ ...other, response: { requestId: 'r1', ok: true, result: {} } }), { code: 'EDITOR_INSTANCE_MISMATCH' });
    relay.respond({ ...page, response: { requestId: 'r1', ok: true, result: { revision: 2 } } });
    assert.deepEqual(await result, { revision: 2 });
    assert.equal(relay.respond({ ...page, response: { requestId: 'r1', ok: true, result: {} } }).accepted, false);
  } finally { relay.close(); }
});

test('disconnect and mutation timeout both preserve unknown-outcome semantics', async () => {
  const relay = createEditorRelay({ timeoutMs: 15 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    const timed = relay.request(message());
    await assert.rejects(timed, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
    const disconnected = relay.request(message('r2'));
    relay.disconnect(page);
    await assert.rejects(disconnected, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  } finally { relay.close(); }
});

test('expired page cannot take new work', async () => {
  const relay = createEditorRelay({ leaseMs: 10 });
  try {
    relay.register({ editorInstanceId: 'e1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(relay.request(message()), { code: 'EDITOR_NOT_READY' });
  } finally { relay.close(); }
});

test('same editor reconnect routes original command query; destroyed editor stays unknown', async () => {
  const relay = createEditorRelay({ minPollIntervalMs: 0 });
  try {
    const original = relay.register({ editorInstanceId: 'e1' });
    relay.disconnect(original);
    const query = { type: 'editor.get_command_result', requestId: 'q1', editorInstanceId: 'e1', commandId: 'c1' };
    assert.deepEqual(await relay.request(query), { status: 'unknown', originalResult: null });
    const reconnected = relay.register({ editorInstanceId: 'e1' });
    const result = relay.request({ ...query, requestId: 'q2' });
    assert.equal(relay.poll(reconnected).messages[0].commandId, 'c1');
    relay.respond({ ...reconnected, response: { requestId: 'q2', ok: true, result: { status: 'applied', originalResult: { commandId: 'c1', revision: 4 } } } });
    assert.equal((await result).status, 'applied');
    relay.disconnect(reconnected);
    relay.register({ editorInstanceId: 'new-editor' });
    assert.deepEqual(await relay.request({ ...query, requestId: 'q3' }), { status: 'unknown', originalResult: null });
  } finally { relay.close(); }
});

test('page and pending-request limits reject excess work', async () => {
  const relay = createEditorRelay({ maxPages: 1, maxPending: 1 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    assert.throws(() => relay.register({ editorInstanceId: 'e2' }), { code: 'EDITOR_NOT_READY' });
    const active = relay.request(message());
    await assert.rejects(relay.request(message('r2')), { code: 'EDITOR_NOT_READY' });
    relay.disconnect(page);
    await assert.rejects(active, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  } finally { relay.close(); }
});

test('poll rate and outbound batch bytes are bounded', async () => {
  const relay = createEditorRelay({ minPollIntervalMs: 50, maxResponseBytes: 170, maxMessageBytes: 130 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    const first = relay.request(message('r1'));
    const second = relay.request(message('r2'));
    first.catch(() => {}); second.catch(() => {});
    const batch = relay.poll(page);
    assert.equal(batch.messages.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 260);
    assert.throws(() => relay.poll(page), { code: 'RATE_LIMITED' });
    relay.disconnect(page);
    await assert.rejects(first, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
    await assert.rejects(second, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  } finally { relay.close(); }
});

test('oversized editor result retains unknown mutation outcome', async () => {
  const relay = createEditorRelay({ maxResponseBytes: 300 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    const pending = relay.request(message());
    relay.poll(page);
    assert.throws(() => relay.respond({ ...page, response: { requestId: 'r1', ok: true, result: 'x'.repeat(301) } }), { code: 'PAYLOAD_TOO_LARGE' });
    await assert.rejects(pending, { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  } finally { relay.close(); }
});

test('oversized command-result query reports payload limit, not editor execution failure', async () => {
  const relay = createEditorRelay({ maxResponseBytes: 300 });
  try {
    const page = relay.register({ editorInstanceId: 'e1' });
    const pending = relay.request({ type: 'editor.get_command_result', requestId: 'q1', editorInstanceId: 'e1', commandId: 'c1' });
    relay.poll(page);
    assert.throws(() => relay.respond({ ...page, response: { requestId: 'q1', ok: true, result: { status: 'applied', originalResult: 'x'.repeat(301) } } }), { code: 'PAYLOAD_TOO_LARGE' });
    await assert.rejects(pending, { code: 'PAYLOAD_TOO_LARGE', outcomeUnknown: true, commandId: 'c1' });
  } finally { relay.close(); }
});

test('final tool HTTP output is bounded without implying mutation failure', () => {
  const big = { ok: true, result: 'x'.repeat(300000) };
  const limited = boundToolOutput(big, { name: 'editor_get_command_result', commandId: 'c1' });
  assert.equal(limited.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(limited.error.outcomeUnknown, true);
  assert.ok(Buffer.byteLength(JSON.stringify(limited)) < 262144);
  assert.equal(boundToolOutput(big, { name: 'editor_apply_command' }).error.code, 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN');
});

test('real loopback HTTP relay routes adapter to simulated browser transport; no DSH or miniPaint', async () => {
  const relay = createEditorRelay({ minPollIntervalMs: 0 });
  const accessToken = 'test-token-012345678901234567890123456789';
  let handler;
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createRelayHttpHandler({ relay, origin, accessToken });
  const transport = {
    connect: async () => ({ editorInstanceId: 'e1' }), dispose() {},
    request: async (m) => {
      assert.equal(m.editorInstanceId, 'e1');
      return { editorInstanceId: 'e1', documentId: 'd1', revision: 7, canvas: { width: 100, height: 100 }, layers: [], selectedLayerId: null };
    },
  };
  let browser;
  try {
    const fetchImpl = (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } });
    browser = await startBrowserRelay({ transport, accessToken, baseUrl: `${origin}/editor-relay`, fetchImpl, pollMs: 2 });
    const bridge = createEditorBridge({ transport: relay });
    assert.equal((await bridge.readState({ editorInstanceId: 'e1' })).revision, 7);
    const forbidden = await fetch(`${origin}/editor-relay/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid', Authorization: `Bearer ${accessToken}` }, body: '{}' });
    assert.equal(forbidden.status, 403);
  } finally {
    await browser?.stop(); relay.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
