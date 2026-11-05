import test from 'node:test';
import assert from 'node:assert/strict';
import { createIframeTransport } from './iframe-transport.mjs';

function fixture(handler) {
  const listeners = new Map();
  let child;
  const iframe = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    contentWindow: { postMessage(message, origin, ports) {
      assert.equal(origin, 'http://localhost:8080');
      child = ports[0];
      child.onmessage = ({ data }) => handler?.(data, child);
      child.start();
      child.postMessage({ requestId: message.requestId, ok: true, result: { editorInstanceId: 'instance-1', ready: true, contractVersion: 1 } });
    } },
  };
  const transport = createIframeTransport({ iframe, origin: 'http://localhost:8080', timeoutMs: 25 });
  return { transport, listeners, close: () => { transport.dispose(); child?.close(); } };
}

test('MessageChannel handshake and correlated response', async () => {
  const f = fixture((m, child) => {
    child.postMessage({ requestId: 'unrelated', ok: true, result: 'ignored' });
    child.postMessage({ requestId: m.requestId, ok: true, result: { revision: 2 } });
  });
  try {
    assert.equal((await f.transport.connect()).editorInstanceId, 'instance-1');
    assert.deepEqual(await f.transport.request({ type: 'editor.read_state', requestId: 'r1', editorInstanceId: 'instance-1' }), { revision: 2 });
    await assert.rejects(f.transport.request({ type: 'editor.read_state', requestId: 'r2', editorInstanceId: 'old' }), { code: 'EDITOR_INSTANCE_MISMATCH' });
  } finally { f.close(); }
});

test('mutation timeout explicitly reports unknown outcome', async () => {
  const f = fixture(() => {});
  try {
    await f.transport.connect();
    await assert.rejects(f.transport.request({ type: 'editor.apply_command', requestId: 'r1', editorInstanceId: 'instance-1', commandId: 'c1' }), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN', commandId: 'c1' });
  } finally { f.close(); }
});

test('frame reload rejects pending request and disposal removes listener', async () => {
  const f = fixture(() => {});
  try {
    await f.transport.connect();
    const request = f.transport.request({ type: 'editor.read_state', requestId: 'r1', editorInstanceId: 'instance-1' });
    await Promise.resolve();
    f.listeners.get('load')();
    await assert.rejects(request, { code: 'EDITOR_INSTANCE_MISMATCH' });
    f.transport.dispose();
    assert.equal(f.listeners.size, 0);
  } finally { f.close(); }
});
