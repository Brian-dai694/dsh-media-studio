import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoEditorBridge, registerVideoEditorTools, resolveVideoIntent } from './video-editor-tools.mjs';

const validState = overrides => ({ editorKind: 'video', editorInstanceId: 'v1', documentId: 'd1', projectId: 'd1', revision: 2, stateDigest: 'digest-2',
  timeline: { duration: 5, fps: 30, currentTime: 0 }, tracks: [{ id: 'v', kind: 'video', clips: [] }], clips: [], capabilities: { webm: true }, ...overrides });
const base = { editorInstanceId: 'v1', documentId: 'd1', expectedRevision: 2, commandId: 'c1', mode: 'conversation', confirmed: true,
  command: { type: 'media.video.clip.move', payload: { clipId: 'clip1', startUs: 100000 } } };

function makeTransport(handler) {
  const messages = [];
  return { messages, transport: { request: async message => { messages.push(message); return handler(message); } } };
}

test('video read state requires editorKind video and timeline contract', async () => {
  const { transport } = makeTransport(() => validState());
  const bridge = createVideoEditorBridge({ transport });
  assert.equal((await bridge.readState({ editorInstanceId: 'v1' })).editorKind, 'video');
  const bad = createVideoEditorBridge({ transport: { request: async () => validState({ editorKind: 'image' }) } });
  await assert.rejects(bad.readState({ editorInstanceId: 'v1' }), { code: 'EDITOR_ERROR' });
});

test('video commands are namespaced, bounded, and revision results are validated', async () => {
  let revision = 2;
  const { transport, messages } = makeTransport(m => m.type === 'editor.apply_command' ? (revision++, { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision, changedObjectIds: ['clip1'] }) : validState({ revision, stateDigest: `digest-${revision}` }));
  const bridge = createVideoEditorBridge({ transport });
  await bridge.applyCommand(base);
  assert.equal(messages[0].command.type, 'media.video.clip.move');
  assert.equal(messages[0].commandId, 'c1');
  await assert.rejects(bridge.applyCommand({ ...base, command: { type: 'layer.update_text', payload: { text: 'x' } } }), { code: 'UNSUPPORTED_COMMAND' });
  await assert.rejects(bridge.applyCommand({ ...base, command: { type: 'media.video.clip.add', payload: { sourceRef: 's', startUs: 0, inUs: 3, outUs: 2 } } }), { code: 'INVALID_REQUEST' });
});

test('expectedRevision conflict is surfaced and is not cached as an applied command', async () => {
  let calls = 0;
  const { transport } = makeTransport(() => { calls++; throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT', revision: 4 }); });
  const bridge = createVideoEditorBridge({ transport });
  await assert.rejects(bridge.applyCommand(base), { code: 'REVISION_CONFLICT', revision: 4 });
  assert.equal(calls, 1);
});

test('duplicate video command id coalesces in-flight and returns completed outcome once', async () => {
  let count = 0; let release; let revision = 2;
  const gate = new Promise(resolve => { release = resolve; });
  const { transport } = makeTransport(async m => { if (m.type === 'editor.read_state') return validState({ revision, stateDigest: `d${revision}` }); count++; await gate; revision++; return { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision, changedObjectIds: ['clip1'] }; });
  const bridge = createVideoEditorBridge({ transport });
  const a = bridge.applyCommand(base); const b = bridge.applyCommand(base);
  release(); const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.commandId, rb.commandId); assert.deepEqual(ra.changedObjectIds, rb.changedObjectIds); assert.equal(count, 1);
  const cached = await bridge.applyCommand(base);
  assert.equal(cached.commandId, ra.commandId); assert.deepEqual(cached.changedObjectIds, ra.changedObjectIds); assert.equal(count, 1);
});

test('unknown timed-out video mutation blocks replay until query confirms outcome', async () => {
  const { transport, messages } = makeTransport(m => m.type === 'editor.apply_command'
    ? new Promise(() => {}) : ({ status: 'unknown', originalResult: null }));
  const bridge = createVideoEditorBridge({ transport, timeoutMs: 5 });
  await assert.rejects(bridge.applyCommand(base), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN', outcomeUnknown: true });
  await assert.rejects(bridge.applyCommand(base), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  assert.equal(messages.filter(m => m.type === 'editor.apply_command').length, 1);
  assert.equal((await bridge.getCommandResult({ editorInstanceId: 'v1', commandId: 'c1' })).status, 'unknown');
});

test('export start/status are asynchronous, bounded, and only return artifact refs', async () => {
  const { transport, messages } = makeTransport(m => m.type === 'editor.export_start'
    ? { editorKind: 'video', commandId: m.commandId, exportId: 'x1', status: 'queued' }
    : { editorKind: 'video', exportId: m.exportId, status: 'completed', artifactRef: 'artifact://x1' });
  const bridge = createVideoEditorBridge({ transport });
  const started = await bridge.startExport({ ...base, format: 'webm' });
  assert.equal(started.status, 'queued');
  const done = await bridge.getExportStatus({ editorInstanceId: 'v1', exportId: 'x1' });
  assert.equal(done.artifactRef, 'artifact://x1');
  assert.equal(JSON.stringify(messages).includes('base64'), false);
  assert.deepEqual(messages.map(m => m.type), ['editor.export_start', 'editor.export_status']);
  const badBridge = createVideoEditorBridge({ transport: { request: async m => ({ editorKind: 'image', exportId: m.exportId, status: 'completed', artifactRef: 'a' }) } });
  await assert.rejects(badBridge.getExportStatus({ editorInstanceId: 'v1', exportId: 'bad' }), { code: 'EDITOR_ERROR' });
});

test('export start timeout is unknown and oversized outputs are bounded', async () => {
  const { transport } = makeTransport(() => new Promise(() => {}));
  const bridge = createVideoEditorBridge({ transport, timeoutMs: 5 });
  await assert.rejects(bridge.startExport({ ...base, format: 'webm' }), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN', outcomeUnknown: true });
  const names = new Map();
  registerVideoEditorTools({ tools: { register: t => names.set(t.name, t) }, transport: { request: async () => ({ editorKind: 'video', exportId: 'x', status: 'completed', artifactRef: 'x'.repeat(300000) }) } });
  await assert.rejects(names.get('media.video.export_status').execute({ editorInstanceId: 'v1', exportId: 'x' }), { code: 'PAYLOAD_TOO_LARGE' });
});

test('conversation intent produces a preview only, requires approval, and audits before/after state', async () => {
  let revision = 2; let readCount = 0; let writes = 0;
  const { transport, messages } = makeTransport(async m => {
    if (m.type === 'editor.read_state') { readCount++; return validState({ revision, stateDigest: `digest-${revision}` }); }
    if (m.type === 'editor.apply_command') { writes++; revision++; return { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision, changedObjectIds: ['clip1'] }; }
    throw new Error(`unexpected ${m.type}`);
  });
  const bridge = createVideoEditorBridge({ transport, authorize: async ({ mode, capability, confirmed }) => mode === 'conversation' && confirmed === true && capability === 'media.video.clip.move' });
  const intent = { intentId: 'i1', editorKind: 'video', projectId: 'd1', editorInstanceId: 'v1', action: '移动片段', payload: { clipId: 'clip1', startUs: 100 }, targets: ['clip1'], expectedRevision: 2, mode: 'conversation', actor: 'user-1', reason: '调整节奏', idempotencyKey: 'idem-1' };
  const prepared = await bridge.prepareIntent(intent);
  assert.equal(prepared.status, 'pending'); assert.equal(writes, 0); assert.equal(prepared.requiresConfirmation, true);
  await assert.rejects(bridge.executeApproved({ editorInstanceId: 'v1', approvalId: prepared.approvalId, auditRef: 'a1', confirmed: false }), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  const result = await bridge.executeApproved({ editorInstanceId: 'v1', approvalId: prepared.approvalId, auditRef: 'a1', confirmed: true });
  assert.equal(writes, 1); assert.equal(result.audit.before.stateDigest, 'digest-2');
  assert.equal(result.audit.after.stateDigest, 'digest-3'); assert.equal(result.audit.auditRef, 'a1');
  assert.equal(readCount, 4); assert.equal(messages.filter(m => m.type === 'editor.apply_command').length, 1);
});

test('autonomous mode requires allowlisted capability and host authorization; high risk always needs confirmation', async () => {
  let writes = 0;
  let revision = 2;
  const { transport } = makeTransport(async m => {
    if (m.type === 'editor.read_state') return validState({ revision, stateDigest: `d${revision}` });
    if (m.type === 'editor.apply_command') { writes++; revision++; return { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision, changedObjectIds: ['clip1'] }; }
  });
  const bridge = createVideoEditorBridge({ transport, authorize: async ({ mode }) => mode === 'autonomous' || mode === 'conversation' });
  await assert.rejects(bridge.applyCommand({ ...base, mode: 'autonomous', capabilities: [] }), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(bridge.applyCommand({ ...base, command: { type: 'media.video.clip.remove', payload: { clipId: 'clip1' } }, mode: 'autonomous', capabilities: ['media.video.clip.remove'] }), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  await assert.rejects(bridge.applyCommand({ ...base, command: { type: 'media.video.clip.remove', payload: { clipId: 'clip1' } }, mode: 'conversation', confirmed: true }), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  await bridge.applyCommand({ ...base, mode: 'autonomous', capabilities: ['media.video.clip.move'], actor: 'agent-1', reason: 'authorized low-risk edit' });
  assert.equal(writes, 1);
});

test('high-risk conversation command requires a matching approval, not only confirmed=true', async () => {
  let writes = 0;
  let revision = 2;
  const { transport } = makeTransport(async m => {
    if (m.type === 'editor.read_state') return validState({ revision, stateDigest: `d${revision}` });
    if (m.type === 'editor.apply_command') { writes++; return { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision: ++revision, changedObjectIds: ['clip1'] }; }
  });
  const bridge = createVideoEditorBridge({ transport, authorize: async ({ confirmed, capability }) => confirmed && capability === 'media.video.clip.remove' });
  const remove = { ...base, command: { type: 'media.video.clip.remove', payload: { clipId: 'clip1' } } };
  await assert.rejects(bridge.applyCommand(remove), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  assert.equal(writes, 0);
  await assert.rejects(bridge.applyCommand({ ...remove, commandId: 'c2', approvalId: 'unregistered' }), { code: 'HUMAN_CONFIRMATION_REQUIRED' });
  assert.equal(writes, 0);
});

test('intent kind/revision/action mismatch and stale approval stop before mutation', async () => {
  assert.throws(() => resolveVideoIntent({ intentId: 'i', projectId: 'd1', actor: 'u', editorInstanceId: 'v1', editorKind: 'image', action: '移动片段', payload: { clipId: 'c', startUs: 0 }, expectedRevision: 0 }), { code: 'EDITOR_KIND_MISMATCH' });
  let revision = 2; let writes = 0;
  const { transport } = makeTransport(async m => {
    if (m.type === 'editor.read_state') return validState({ revision, stateDigest: `d${revision}` });
    if (m.type === 'editor.apply_command') { writes++; return { editorKind: 'video', documentId: 'd1', commandId: m.commandId, revision: ++revision, changedObjectIds: ['clip1'] }; }
  });
  const bridge = createVideoEditorBridge({ transport });
  const prepared = await bridge.prepareIntent({ intentId: 'i2', projectId: 'd1', actor: 'u', editorInstanceId: 'v1', editorKind: 'video', action: '移动片段', payload: { clipId: 'clip1', startUs: 20 }, expectedRevision: 2, mode: 'conversation' });
  revision++;
  await assert.rejects(bridge.executeApproved({ editorInstanceId: 'v1', approvalId: prepared.approvalId, auditRef: 'a2', confirmed: true }), { code: 'REVISION_CONFLICT' });
  assert.equal(writes, 0);
});

test('tool registration is namespaced and exposes preview/approval tools', () => {
  const names = [];
  registerVideoEditorTools({ tools: { register: t => names.push(t.name) }, transport: { request: async () => ({}) } });
  assert.deepEqual(names, ['media.video.prepare_intent', 'media.video.execute_approved', 'media.video.read_state', 'media.video.apply_command', 'media.video.get_command_result', 'media.video.export_start', 'media.video.export_status']);
  assert.equal(names.some(name => name.startsWith('editor_')), false);
});
