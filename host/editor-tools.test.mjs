import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorBridge, EditorBridgeError, registerEditorTools } from './editor-tools.mjs';

const baseState = (revision = 3) => ({
  editorInstanceId: 'editor-a', documentId: 'doc-a', revision,
  canvas: { width: 800, height: 600 }, selectedLayerId: 'layer-1',
  layers: [{ id: 'layer-1', type: 'text', text: 'before' }],
});

function makeTransport({ revision = 3, onApply } = {}) {
  const calls = [];
  return {
    calls,
    request: async (message) => {
      calls.push(message);
      if (message.type === 'editor.read_state') return baseState(revision);
      if (message.type === 'editor.get_command_result') return { status: 'unknown', originalResult: null };
      if (message.type === 'editor.apply_command') {
        return onApply ? onApply(message) : {
          documentId: message.documentId,
          revision: message.expectedRevision + 1,
          commandId: message.commandId,
          changedLayerIds: ['layer-1'],
          stateSummary: { selectedLayerId: 'layer-1' },
        };
      }
      throw new Error(`unexpected request: ${message.type}`);
    },
  };
}

test('reads the state only from the selected editor instance', async () => {
  const transport = makeTransport();
  const bridge = createEditorBridge({ transport });
  assert.equal((await bridge.readState({ editorInstanceId: 'editor-a' })).selectedLayerId, 'layer-1');
  assert.equal(transport.calls[0].type, 'editor.read_state');
});

test('propagates editor-side conflict after a human edit; mock does not prove native atomicity', async () => {
  const transport = makeTransport({ onApply: () => {
    throw new EditorBridgeError('REVISION_CONFLICT', 'Human edit committed first.', { revision: 4 });
  } });
  const bridge = createEditorBridge({ transport });
  await bridge.readState({ editorInstanceId: 'editor-a' });
  await assert.rejects(bridge.applyCommand({
    editorInstanceId: 'editor-a', documentId: 'doc-a', expectedRevision: 3,
    commandId: 'cmd-stale', command: { type: 'layer.update_text', payload: { layerId: 'layer-1', text: 'after' } },
  }), (error) => error instanceof EditorBridgeError && error.code === 'REVISION_CONFLICT' && error.revision === 4);
  assert.equal(transport.calls.filter((call) => call.type === 'editor.apply_command').length, 1);
});

test('sends one valid structured command and returns its committed revision', async () => {
  const transport = makeTransport();
  const bridge = createEditorBridge({ transport });
  const result = await bridge.applyCommand({
    editorInstanceId: 'editor-a', documentId: 'doc-a', expectedRevision: 3,
    commandId: 'cmd-1', command: { type: 'layer.update_text', payload: { layerId: 'layer-1', text: 'after' } },
  });
  assert.equal(result.revision, 4);
  assert.equal(transport.calls.at(-1).type, 'editor.apply_command');
});

test('rejects arbitrary commands and oversized text locally', async () => {
  const transport = makeTransport();
  const bridge = createEditorBridge({ transport });
  const common = { editorInstanceId: 'editor-a', documentId: 'doc-a', expectedRevision: 3, commandId: 'cmd-bad' };
  await assert.rejects(bridge.applyCommand({ ...common, command: { type: 'eval', payload: { code: '1+1' } } }), { code: 'UNSUPPORTED_COMMAND' });
  await assert.rejects(bridge.applyCommand({ ...common, command: { type: 'layer.update_text', payload: { layerId: 'layer-1', text: 'x'.repeat(4001) } } }), { code: 'INVALID_REQUEST' });
  assert.equal(transport.calls.length, 0);
});

test('coalesces concurrent duplicate command ids and replays completed results', async () => {
  let applyCount = 0;
  const transport = makeTransport({ onApply: async (message) => {
    applyCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { documentId: message.documentId, revision: 4, commandId: message.commandId, changedLayerIds: ['layer-1'], stateSummary: {} };
  } });
  const bridge = createEditorBridge({ transport });
  const input = {
    editorInstanceId: 'editor-a', documentId: 'doc-a', expectedRevision: 3,
    commandId: 'cmd-idempotent', command: { type: 'layer.set_visibility', payload: { layerId: 'layer-1', visible: false } },
  };
  const [first, second] = await Promise.all([bridge.applyCommand(input), bridge.applyCommand(input)]);
  const third = await bridge.applyCommand(input);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(applyCount, 1);
});

test('reports an editor timeout with a stable error code', async () => {
  const bridge = createEditorBridge({ transport: { request: () => new Promise(() => {}) }, timeoutMs: 10 });
  await assert.rejects(bridge.readState({ editorInstanceId: 'editor-a' }), { code: 'EDITOR_TIMEOUT' });
});

test('timeout blocks replay until editor confirms applied; unknown remains blocked', async () => {
  let calls = 0;
  let status = 'unknown';
  const result = { documentId: 'doc-a', revision: 4, commandId: 'slow', changedLayerIds: [], stateSummary: {} };
  const bridge = createEditorBridge({ timeoutMs: 10, transport: { request: async (message) => {
    if (message.type === 'editor.get_command_result') return { status, originalResult: status === 'applied' ? result : null };
    calls++;
    return new Promise(() => {});
  } } });
  const input = { editorInstanceId: 'editor-a', documentId: 'doc-a', expectedRevision: 3,
    commandId: 'slow', command: { type: 'layer.update_text', payload: { layerId: 'layer-1', text: 'after' } } };
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  assert.equal((await bridge.getCommandResult(input)).status, 'unknown');
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
  status = 'applied';
  await bridge.getCommandResult(input);
  assert.deepEqual(await bridge.applyCommand(input), result);
  assert.equal(calls, 1);
});

test('registers all tools with parameter and output contracts', () => {
  const registered = [];
  const tools = { register: (tool) => registered.push(tool) };
  const defineTool = (tool) => tool;
  registerEditorTools({ tools, defineTool, transport: makeTransport() });
  assert.deepEqual(registered.map((tool) => tool.name), ['editor_read_state', 'editor_apply_command', 'editor_get_command_result']);
  assert.equal(typeof registered[0].output.render, 'function');
  assert.equal(registered[0].output.schema.type, 'object');
  assert.equal(registered[1].parameters.properties.expectedRevision.required, true);
});
