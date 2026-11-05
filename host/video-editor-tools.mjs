const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 262_144;
const ALLOWED_VIDEO_COMMANDS = new Set(['media.video.clip.add', 'media.video.clip.trim', 'media.video.clip.move', 'media.video.clip.remove', 'media.video.track.add', 'media.video.track.reorder', 'media.video.overlay.add', 'media.video.overlay.update']);
const OVERLAY_KINDS = new Set(['text', 'image']);
const JSON_OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const str = description => ({ type: 'string', description });
const int = description => ({ type: 'integer', description });

export class VideoBridgeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'VideoBridgeError'; this.code = code; Object.assign(this, details); }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const requireId = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new VideoBridgeError('INVALID_REQUEST', `${name} must be a non-empty string up to 256 characters.`);
};
const finite = (value, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new VideoBridgeError('INVALID_REQUEST', `${name} is outside the supported range.`);
};
const clone = value => structuredClone(value);

function validateEnvelope(value, mutation = false) {
  if (!isObject(value)) throw new VideoBridgeError('INVALID_REQUEST', 'Request must be an object.');
  requireId(value.editorInstanceId, 'editorInstanceId');
  if (mutation) {
    requireId(value.documentId, 'documentId');
    requireId(value.commandId, 'commandId');
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new VideoBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
  }
}

function validateVideoState(state, editorInstanceId) {
  if (!isObject(state) || state.editorInstanceId !== editorInstanceId || typeof state.documentId !== 'string' ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || state.editorKind !== 'video' ||
      !isObject(state.timeline) || !Number.isFinite(state.timeline.duration) || state.timeline.duration < 0 ||
      (state.timeline.fps !== null && (!Number.isFinite(state.timeline.fps) || state.timeline.fps <= 0)) || !Array.isArray(state.tracks) ||
      !Array.isArray(state.clips) || !isObject(state.capabilities)) {
    throw new VideoBridgeError('EDITOR_ERROR', 'Video editor returned an invalid state or missing video capability.');
  }
  return state;
}

function validateCommand(command) {
  if (!isObject(command) || typeof command.type !== 'string' || !ALLOWED_VIDEO_COMMANDS.has(command.type) || !isObject(command.payload)) {
    throw new VideoBridgeError('UNSUPPORTED_COMMAND', 'Command is not in the video allowlist.');
  }
  const p = command.payload;
  switch (command.type) {
    case 'media.video.clip.add':
      requireId(p.sourceRef, 'sourceRef');
      finite(p.startUs, 'startUs', { min: 0 }); finite(p.inUs, 'inUs', { min: 0 }); finite(p.outUs, 'outUs', { min: 0 });
      if (p.outUs <= p.inUs) throw new VideoBridgeError('INVALID_REQUEST', 'outUs must be greater than inUs.');
      break;
    case 'media.video.clip.trim':
      requireId(p.clipId, 'clipId');
      if (p.inUs !== undefined) finite(p.inUs, 'inUs', { min: 0 });
      if (p.outUs !== undefined) finite(p.outUs, 'outUs', { min: 0 });
      if (p.inUs === undefined && p.outUs === undefined) throw new VideoBridgeError('INVALID_REQUEST', 'At least one trim boundary is required.');
      break;
    case 'media.video.clip.move':
      requireId(p.clipId, 'clipId'); finite(p.startUs, 'startUs', { min: 0 });
      break;
    case 'media.video.clip.remove':
      requireId(p.clipId, 'clipId');
      break;
    case 'media.video.track.add':
      requireId(p.trackId, 'trackId');
      if (!['video', 'image', 'text', 'audio'].includes(p.kind)) throw new VideoBridgeError('INVALID_REQUEST', 'Unsupported track kind.');
      break;
    case 'media.video.track.reorder':
      requireId(p.trackId, 'trackId');
      if (!Number.isSafeInteger(p.toIndex) || p.toIndex < 0) throw new VideoBridgeError('INVALID_REQUEST', 'toIndex must be a non-negative integer.');
      break;
    case 'media.video.overlay.add':
      if (!OVERLAY_KINDS.has(p.kind)) throw new VideoBridgeError('INVALID_REQUEST', 'Overlay kind must be text or image.');
      if (p.kind === 'text' && (typeof p.text !== 'string' || p.text.length > 4000)) throw new VideoBridgeError('INVALID_REQUEST', 'Text overlay must be at most 4000 characters.');
      if (p.kind === 'image') requireId(p.sourceRef, 'sourceRef');
      finite(p.startUs, 'startUs', { min: 0 }); finite(p.durationUs, 'durationUs', { min: 1 });
      break;
    case 'media.video.overlay.update':
      requireId(p.overlayId, 'overlayId');
      if (p.startUs !== undefined) finite(p.startUs, 'startUs', { min: 0 });
      if (p.durationUs !== undefined) finite(p.durationUs, 'durationUs', { min: 1 });
      if (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 4000)) throw new VideoBridgeError('INVALID_REQUEST', 'Text overlay must be at most 4000 characters.');
      if (p.visible !== undefined && typeof p.visible !== 'boolean') throw new VideoBridgeError('INVALID_REQUEST', 'visible must be boolean.');
      if (p.transform !== undefined && !isObject(p.transform)) throw new VideoBridgeError('INVALID_REQUEST', 'transform must be an object.');
      break;
  }
}

function bounded(value, name, commandId) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) <= MAX_OUTPUT_BYTES) return value;
  return { ok: false, error: { code: name === 'media.video.apply_command' || name === 'media.video.export_start'
    ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'PAYLOAD_TOO_LARGE',
    message: 'Video tool response exceeded the output limit; mutation outcome must be queried, not replayed.',
    outcomeUnknown: true, ...(commandId ? { commandId } : {}) } };
}

function parameterSchema(properties) { return { type: 'object', additionalProperties: false, properties }; }

export function resolveVideoIntent(intent) {
  if (!isObject(intent) || typeof intent.action !== 'string') throw new VideoBridgeError('INVALID_REQUEST', 'Conversation intent must be a structured action object.');
  requireId(intent.intentId, 'intentId');
  requireId(intent.projectId, 'projectId');
  requireId(intent.actor, 'actor');
  const map = {
    '剪辑片段': 'media.video.clip.trim', '移动片段': 'media.video.clip.move', '删除片段': 'media.video.clip.remove',
    '添加视频片段': 'media.video.clip.add', '添加文字叠加': 'media.video.overlay.add', '更新叠加': 'media.video.overlay.update',
  };
  const type = map[intent.action];
  if (!type) throw new VideoBridgeError('UNSUPPORTED_COMMAND', 'Conversation intent is not supported; no edit was applied.');
  const command = { type, payload: clone(intent.payload || {}) };
  validateCommand(command);
  if (intent.editorKind !== 'video') throw new VideoBridgeError('EDITOR_KIND_MISMATCH', 'Intent is not addressed to the video editor.');
  if (!Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 0) throw new VideoBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
  const highRisk = new Set(['media.video.clip.remove', 'media.video.clip.add']).has(type);
  if (!['conversation', 'autonomous'].includes(intent.mode)) throw new VideoBridgeError('INVALID_REQUEST', 'Intent mode must be conversation or autonomous.');
  return { intentId: intent.intentId, editorKind: 'video', projectId: intent.projectId, targets: Array.isArray(intent.targets) ? intent.targets : [],
    operation: intent.action, params: command.payload, expectedRevision: intent.expectedRevision, mode: intent.mode,
    risk: highRisk ? 'high' : 'low', actor: intent.actor, reason: String(intent.reason || ''),
    expiresAt: intent.expiresAt, idempotencyKey: intent.idempotencyKey || intent.intentId,
    command, preview: { action: intent.action, commandType: type, payload: command.payload, requiresConfirmation: true,
      impact: { targetCount: Array.isArray(intent.targets) ? intent.targets.length : 0 }, risk: highRisk ? 'high' : 'low' } };
}

export function createVideoEditorBridge({ transport, timeoutMs = DEFAULT_TIMEOUT_MS, allowedOrigin,
  authorize = async ({ mode, confirmed }) => mode === 'conversation' && confirmed === true } = {}) {
  if (!transport || typeof transport.request !== 'function') throw new TypeError('transport.request is required');
  if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
  const completed = new Map(); const inFlight = new Map(); const uncertain = new Map();
  async function request(type, payload, mutation = false) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let timer;
    const send = Promise.resolve().then(() => transport.request({ type, requestId, ...payload }, { timeoutMs, allowedOrigin }));
    try {
      return await Promise.race([send, new Promise((_, reject) => { timer = setTimeout(() => reject(new VideoBridgeError(mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_TIMEOUT', mutation ? 'Video command outcome is unknown; query the original command or export id.' : 'Video editor did not respond in time.', { commandId: payload.commandId, exportId: payload.exportId, outcomeUnknown: mutation })), timeoutMs); })]);
    } catch (error) {
      if (error instanceof VideoBridgeError) throw error;
      if (error?.code) throw new VideoBridgeError(error.code, error.message || 'Video editor request failed.', { revision: error.revision, outcomeUnknown: error.outcomeUnknown });
      throw new VideoBridgeError('EDITOR_ERROR', error?.message || 'Video editor request failed.');
    } finally { clearTimeout(timer); }
  }
  const approvals = new Map();
  const auditLog = [];
  return {
    auditLog,
    async prepareIntent(intent) {
      const normalized = resolveVideoIntent(intent);
      requireId(intent.editorInstanceId, 'editorInstanceId');
      const before = await this.readState({ editorInstanceId: intent.editorInstanceId, documentId: normalized.projectId });
      if (before.revision !== normalized.expectedRevision) throw new VideoBridgeError('REVISION_CONFLICT', 'Project changed; refresh the preview before approval.', { revision: before.revision });
      const approvalId = globalThis.crypto?.randomUUID?.() ?? `approval-${Date.now()}`;
      const record = { ...normalized, approvalId, expiresAt: normalized.expiresAt || new Date(Date.now() + 5 * 60_000).toISOString(),
        before: { revision: before.revision, stateDigest: before.stateDigest }, status: 'pending' };
      approvals.set(approvalId, record);
      return { status: 'pending', intentId: record.intentId, approvalId, mode: record.mode, actor: record.actor, reason: record.reason,
        expiresAt: record.expiresAt, idempotencyKey: record.idempotencyKey, command: record.command,
        impact: record.preview.impact, risk: record.risk, currentState: record.before, requiresConfirmation: true };
    },
    async executeApproved(input) {
      requireId(input.approvalId, 'approvalId'); requireId(input.auditRef, 'auditRef');
      const record = approvals.get(input.approvalId);
      if (!record || record.status !== 'pending') throw new VideoBridgeError('APPROVAL_NOT_FOUND', 'Approval is missing or already consumed.');
      if (Date.parse(record.expiresAt) <= Date.now()) { record.status = 'expired'; throw new VideoBridgeError('APPROVAL_EXPIRED', 'Approval expired; prepare a fresh preview.'); }
      if (input.confirmed !== true) throw new VideoBridgeError('HUMAN_CONFIRMATION_REQUIRED', 'Approval must be explicitly confirmed.');
      const before = await this.readState({ editorInstanceId: input.editorInstanceId, documentId: record.projectId });
      if (before.revision !== record.expectedRevision || before.stateDigest !== record.before.stateDigest) throw new VideoBridgeError('REVISION_CONFLICT', 'Project changed after preview; prepare a fresh approval.', { revision: before.revision });
      record.status = 'consumed';
      try {
        const result = await this.applyCommand({ editorInstanceId: input.editorInstanceId, documentId: record.projectId,
          expectedRevision: record.expectedRevision, commandId: record.idempotencyKey, command: record.command,
          mode: record.mode, confirmed: true, capabilities: input.capabilities || [], actor: record.actor, reason: record.reason,
          approvalId: record.approvalId, intentId: record.intentId });
        const after = await this.readState({ editorInstanceId: input.editorInstanceId, documentId: record.projectId });
        const audit = { auditRef: input.auditRef, intentId: record.intentId, approvalId: record.approvalId, idempotencyKey: record.idempotencyKey,
          actor: record.actor, mode: record.mode, reason: record.reason, commandType: record.command.type,
          before: record.before, after: { revision: after.revision, stateDigest: after.stateDigest }, status: 'applied' };
        auditLog.push(audit);
        return { ...result, audit };
      } catch (error) {
        record.status = error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' ? 'unknown' : 'rejected';
        const audit = { auditRef: input.auditRef, intentId: record.intentId, approvalId: record.approvalId,
          idempotencyKey: record.idempotencyKey, actor: record.actor, mode: record.mode,
          commandType: record.command.type, before: record.before, status: record.status, errorCode: error.code || 'EDITOR_ERROR' };
        auditLog.push(audit);
        throw error;
      }
    },
    async readState(input) {
      validateEnvelope(input);
      const state = validateVideoState(await request('editor.read_state', { editorInstanceId: input.editorInstanceId }), input.editorInstanceId);
      if (input.documentId && state.documentId !== input.documentId) throw new VideoBridgeError('DOCUMENT_MISMATCH', 'The active video project changed.');
      return state;
    },
    async getCommandResult(input) {
      validateEnvelope(input); requireId(input.commandId, 'commandId');
      const result = await request('editor.get_command_result', { editorInstanceId: input.editorInstanceId, commandId: input.commandId });
      if (!isObject(result) || !['applied', 'rejected', 'unknown'].includes(result.status) || (result.originalResult !== null && !isObject(result.originalResult))) throw new VideoBridgeError('EDITOR_ERROR', 'Video editor returned an invalid command result.');
      const key = `${input.editorInstanceId}\0${input.commandId}`;
      if (result.status === 'applied' && result.originalResult) { completed.set(key, result.originalResult); uncertain.delete(key); }
      return result;
    },
    async applyCommand(input) {
      validateEnvelope(input, true); validateCommand(input.command);
      if (!['conversation', 'autonomous'].includes(input.mode)) throw new VideoBridgeError('INVALID_REQUEST', 'mode must be conversation or autonomous.');
      if (input.mode === 'conversation' && input.confirmed !== true) throw new VideoBridgeError('HUMAN_CONFIRMATION_REQUIRED', 'Conversation edits require explicit confirmation.');
      const highRisk = ['media.video.clip.add', 'media.video.clip.remove'].includes(input.command.type);
      if (highRisk) {
        const approved = [...approvals.values()].some(record => record.status === 'consumed' &&
          record.approvalId === input.approvalId && record.editorKind === 'video' &&
          record.command.type === input.command.type && record.idempotencyKey === input.commandId &&
          record.projectId === input.documentId && record.expectedRevision === input.expectedRevision &&
          record.mode === 'conversation' && input.mode === 'conversation' && input.confirmed === true);
        if (!approved) throw new VideoBridgeError('HUMAN_CONFIRMATION_REQUIRED', 'High-risk edits require a matching Host approval record; confirmed alone is insufficient.');
      }
      if (input.mode === 'autonomous' && (!Array.isArray(input.capabilities) || !input.capabilities.includes(input.command.type))) throw new VideoBridgeError('CAPABILITY_DENIED', 'Autonomous execution is not authorized for this command.');
      if (!await authorize({ mode: input.mode, confirmed: input.confirmed === true, capability: input.command.type, editorInstanceId: input.editorInstanceId, documentId: input.documentId, actor: input.actor, reason: input.reason, approvalId: input.approvalId, intentId: input.intentId })) throw new VideoBridgeError('CAPABILITY_DENIED', 'Execution denied by the host authorization policy.');
      const key = `${input.editorInstanceId}\0${input.commandId}`;
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const operation = (async () => {
        const result = await request('editor.apply_command', { editorInstanceId: input.editorInstanceId, documentId: input.documentId,
          expectedRevision: input.expectedRevision, commandId: input.commandId, command: clone(input.command) }, true);
        if (!isObject(result) || result.editorKind !== 'video' || result.documentId !== input.documentId || result.commandId !== input.commandId ||
            !Number.isSafeInteger(result.revision) || result.revision <= input.expectedRevision || !Array.isArray(result.changedObjectIds)) {
          throw new VideoBridgeError('EDITOR_ERROR', 'Video editor returned an invalid mutation result.');
        }
        completed.set(key, result); return result;
      })();
      inFlight.set(key, operation);
      try {
        const result = await operation;
        const auditState = await this.readState({ editorInstanceId: input.editorInstanceId, documentId: input.documentId });
        completed.set(key, { ...result, audit: { revision: auditState.revision, stateDigest: auditState.stateDigest, projectId: auditState.projectId } });
        return completed.get(key);
      }
      catch (error) { if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error); throw error; }
      finally { inFlight.delete(key); }
    },
    async startExport(input) {
      validateEnvelope(input, true); requireId(input.commandId, 'commandId');
      const format = input.format;
      if (!['webm', 'mp4'].includes(format)) throw new VideoBridgeError('INVALID_REQUEST', 'Export format must be webm or mp4.');
      const key = `${input.editorInstanceId}\0${input.commandId}`;
      if (completed.has(key)) return completed.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const result = await request('editor.export_start', { editorInstanceId: input.editorInstanceId, documentId: input.documentId,
        expectedRevision: input.expectedRevision, commandId: input.commandId, format }, true).catch(error => {
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error);
        throw error;
      });
      if (!isObject(result) || result.editorKind !== 'video' || result.commandId !== input.commandId || typeof result.exportId !== 'string' || !result.exportId || !['queued', 'running', 'completed', 'failed'].includes(result.status)) throw new VideoBridgeError('EDITOR_ERROR', 'Video editor returned an invalid export job.');
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new VideoBridgeError('PAYLOAD_TOO_LARGE', 'Export job response exceeded the output limit.');
      completed.set(key, result);
      return result;
    },
    async getExportStatus(input) {
      validateEnvelope(input); requireId(input.exportId, 'exportId');
      const result = await request('editor.export_status', { editorInstanceId: input.editorInstanceId, exportId: input.exportId });
      if (!isObject(result) || result.editorKind !== 'video' || result.exportId !== input.exportId || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(result.status)) throw new VideoBridgeError('EDITOR_ERROR', 'Video editor returned an invalid export status.');
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new VideoBridgeError('PAYLOAD_TOO_LARGE', 'Export status response exceeded the output limit.');
      if (result.status === 'completed' && typeof result.artifactRef !== 'string') throw new VideoBridgeError('EDITOR_ERROR', 'Completed export is missing artifactRef.');
      return result;
    },
  };
}

export function registerVideoEditorTools({ tools, defineTool = value => value, transport, timeoutMs, allowedOrigin }) {
  if (!tools || typeof tools.register !== 'function') throw new TypeError('tools.register is required');
  const bridge = createVideoEditorBridge({ transport, timeoutMs, allowedOrigin });
  const base = { editorInstanceId: { ...str('Mounted video editor instance id.'), required: true } };
  const read = parameterSchema(base);
  const command = parameterSchema({ ...base, documentId: { ...str('Open video project id.'), required: true }, expectedRevision: { ...int('Current video project revision.'), required: true }, commandId: { ...str('Idempotency key.'), required: true }, command: { type: 'object', required: true, additionalProperties: true }, mode: { type: 'string', enum: ['conversation', 'autonomous'], required: true }, confirmed: { type: 'boolean' }, capabilities: { type: 'array', items: { type: 'string' } }, actor: str('Audited actor identifier.'), reason: str('Reason for the operation.') });
  const exportStart = parameterSchema({ ...base, documentId: { ...str('Open video project id.'), required: true }, expectedRevision: { ...int('Current video project revision.'), required: true }, commandId: { ...str('Idempotency key.'), required: true }, format: { type: 'string', enum: ['webm', 'mp4'], required: true } });
  const exportStatus = parameterSchema({ ...base, exportId: { ...str('Export job id returned by export_start.'), required: true } });
  const add = (name, description, parameters, execute) => tools.register(defineTool({ name, description, parameters, output: JSON_OUTPUT, execute: async args => {
    const result = await execute(args);
    const out = bounded({ ok: true, result }, name, args.commandId);
    if (!out.ok) throw new VideoBridgeError(out.error.code, out.error.message, out.error);
    return out.result;
  } }));
  const intentSchema = parameterSchema({ ...base, intentId: { ...str('Conversation intent identifier.'), required: true }, projectId: { ...str('Target project id.'), required: true }, editorKind: { type: 'string', enum: ['video'], required: true }, action: { ...str('Supported natural-language action label.'), required: true }, payload: { type: 'object', required: true }, targets: { type: 'array', items: { type: 'string' } }, expectedRevision: { ...int('Current revision.'), required: true }, mode: { type: 'string', enum: ['conversation', 'autonomous'], required: true }, actor: { ...str('Actor id.'), required: true }, reason: str('Reason for the operation.'), expiresAt: str('Optional ISO expiry.'), idempotencyKey: str('Optional idempotency key.') });
  const approvalSchema = parameterSchema({ ...base, approvalId: { ...str('Approval id from prepare_intent.'), required: true }, auditRef: { ...str('Audit reference.'), required: true }, confirmed: { type: 'boolean', required: true }, capabilities: { type: 'array', items: { type: 'string' } } });
  add('media.video.prepare_intent', 'Normalize a DSH conversation intent into a preview; never edits the project.', intentSchema, args => bridge.prepareIntent(args));
  add('media.video.execute_approved', 'Apply a confirmed or authorized video command through the editor bridge, then audit read_state.', approvalSchema, args => bridge.executeApproved(args));
  add('media.video.read_state', 'Read video project timeline, tracks, clips and runtime capabilities.', read, args => bridge.readState(args));
  add('media.video.apply_command', 'Apply one allowlisted video timeline or overlay command using expectedRevision.', command, args => bridge.applyCommand(args));
  add('media.video.get_command_result', 'Query the result of a video mutation by its original commandId.', parameterSchema({ ...base, commandId: { ...str('Original command id.'), required: true } }), args => bridge.getCommandResult(args));
  add('media.video.export_start', 'Start asynchronous video export; media bytes stay in the editor and only artifactRef is returned.', exportStart, args => bridge.startExport(args));
  add('media.video.export_status', 'Read asynchronous export job status and artifactRef.', exportStatus, args => bridge.getExportStatus(args));
  return bridge;
}
