import assert from 'node:assert/strict';
import { createProject, createHistory, commit, reduceProject, readState } from '../video-state.mjs';
import { createEditorBridge, toEditorCommand } from '../video-bridge.mjs';

let count = 0;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const test = async (name, fn) => { await fn(); count++; console.log(`PASS ${count}: ${name}`); };

function harness() {
  let history = createHistory(createProject());
  const instanceId = 'instance-video-1';
  const state = () => history.present;
  const fakeWindow = {
    handlers: [],
    addEventListener(type, fn) { if (type === 'message') this.handlers.push(fn); },
    removeEventListener(type, fn) { this.handlers = this.handlers.filter(item => item !== fn); },
    emit(event) { for (const fn of [...this.handlers]) fn(event); }
  };
  const bridge = createEditorBridge({
    instanceId,
    getState: () => readState(state(), history, instanceId, { webm: true }),
    applyCommand: command => { const ids = [command.clipId, command.overlayId, command.clip?.id, command.overlay?.id].filter(Boolean); history = commit(history, reduceProject(state(), command)); return { changedObjectIds: [...new Set(ids)] }; },
    targetWindow: fakeWindow,
    expectedOrigin: 'http://127.0.0.1:1234'
  });
  const replies = [];
  const port = { onmessage: null, start() {}, close() {}, postMessage(message) { replies.push(message); } };
  const connect = () => fakeWindow.emit({ origin: 'http://127.0.0.1:1234', data: { type: 'dsh.editor.connect', requestId: 'connect-1' }, ports: [port] });
  const request = async message => { replies.length = 0; port.onmessage({ data: message }); await tick(); return replies[0]; };
  return { bridge, fakeWindow, port, connect, request, replies, state, get history() { return history; } };
}

await test('handshake returns ready envelope with contractVersion 1', async () => {
  const h = harness();
  h.connect();
  assert.deepEqual(h.replies[0], { requestId: 'connect-1', ok: true, result: { ready: true, contractVersion: 1, editorInstanceId: 'instance-video-1' } });
  assert.equal(h.bridge.connected, true);
  h.bridge.dispose();
});

await test('connect from a foreign origin is ignored', async () => {
  const h = harness();
  h.fakeWindow.emit({ origin: 'http://evil.test', data: { type: 'dsh.editor.connect', requestId: 'connect-x' }, ports: [h.port] });
  assert.equal(h.replies.length, 0);
  assert.equal(h.bridge.connected, false);
  h.bridge.dispose();
});

await test('read_state returns the editor-owned state summary', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.read_state', requestId: 'r1', editorInstanceId: 'instance-video-1' });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.editorKind, 'video');
  assert.equal(reply.result.revision, 0);
  assert.equal(typeof reply.result.stateDigest, 'string');
  assert.equal(JSON.stringify(reply.result).includes('bytes'), false);
  h.bridge.dispose();
});

await test('stale expectedRevision is rejected and does not mutate', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.apply_command', requestId: 'a1', editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 99, commandId: 'cmd-1', command: { type: 'media.video.overlay.add', payload: { kind: 'text', text: '片头', startUs: 0, durationUs: 1000000 } } });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'REVISION_CONFLICT');
  assert.equal(h.state().revision, 0);
  assert.equal(h.state().overlays.length, 0);
  h.bridge.dispose();
});

await test('apply_command is idempotent by commandId and reports changed ids', async () => {
  const h = harness();
  h.connect();
  const command = { type: 'media.video.overlay.add', payload: { kind: 'text', text: '片头字幕', startUs: 0, durationUs: 2000000 } };
  const base = { editorInstanceId: 'instance-video-1', documentId: h.state().projectId, expectedRevision: 0, commandId: 'cmd-once', command };
  const first = await h.request({ type: 'editor.apply_command', requestId: 'a2', ...base });
  assert.equal(first.ok, true);
  assert.equal(first.result.revision, 1);
  assert.equal(first.result.commandId, 'cmd-once');
  assert.equal(first.result.changedObjectIds.length, 1);
  const second = await h.request({ type: 'editor.apply_command', requestId: 'a3', ...base });
  assert.equal(second.ok, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(h.state().revision, 1);
  const result = await h.request({ type: 'editor.get_command_result', requestId: 'g1', editorInstanceId: 'instance-video-1', commandId: 'cmd-once' });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'applied');
  assert.equal(result.result.originalResult.commandId, 'cmd-once');
  h.bridge.dispose();
});

await test('unknown commandId reports unknown instead of being replayed', async () => {
  const h = harness();
  h.connect();
  const reply = await h.request({ type: 'editor.get_command_result', requestId: 'g2', editorInstanceId: 'instance-video-1', commandId: 'never-seen' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { status: 'unknown', originalResult: null });
  assert.equal(h.state().revision, 0);
  h.bridge.dispose();
});

await test('microsecond payloads map to seconds without losing the single-track limit', () => {
  const add = toEditorCommand({ type: 'media.video.clip.add', payload: { sourceRef: 'local:a.webm', inUs: 1000000, outUs: 4000000 } });
  assert.equal(add.clip.in, 1);
  assert.equal(add.clip.out, 4);
  const trim = toEditorCommand({ type: 'media.video.clip.trim', payload: { clipId: 'c1', inUs: 2000000, outUs: 3000000 } });
  assert.deepEqual([trim.in, trim.out], [2, 3]);
  assert.throws(() => toEditorCommand({ type: 'layer.update_text', payload: {} }), /白名单/);
});

await test('clip.add honours trim boundaries and overlay.add honours start/end', () => {
  const withClip = reduceProject(createProject(), { type: 'media.video.clip.add', clip: { id: 'c9', sourceRef: 'local:c9', name: 'c9', duration: 10, in: 2, out: 6 } });
  assert.equal(withClip.tracks[0].clips[0].in, 2);
  assert.equal(withClip.tracks[0].clips[0].out, 6);
  const withOverlay = reduceProject(withClip, { type: 'media.video.overlay.add', overlay: { id: 'o9', kind: 'text', name: '标题', content: '标题', start: 1, end: 3 } });
  const overlay = withOverlay.overlays[0];
  assert.deepEqual([overlay.start, overlay.end], [1, 3]);
});

console.log(JSON.stringify({ passed: count, scope: 'editor-side bridge + state mapping; browser MediaChannel/relay not exercised' }));
