const MAX_TEXT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 10_000;
const COMMANDS = new Set([
  'layer.add_text',
  'layer.update_text',
  'layer.set_transform',
  'layer.set_visibility',
  'layer.reorder',
]);

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

const string = (description) => ({ type: 'string', description });
const integer = (description) => ({ type: 'integer', description });

export class EditorBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EditorBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

function validateEnvelope(value, { command = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EditorBridgeError('INVALID_REQUEST', 'Request must be an object.');
  }
  for (const key of ['editorInstanceId', ...(command ? ['documentId'] : [])]) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 256) {
      throw new EditorBridgeError('INVALID_REQUEST', `${key} must be a non-empty string.`);
    }
  }
  if (command && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
    throw new EditorBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
  }
}

function validateCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || !COMMANDS.has(command.type)) {
    throw new EditorBridgeError('UNSUPPORTED_COMMAND', 'Command is not in the editor allowlist.');
  }
  const p = command.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new EditorBridgeError('INVALID_REQUEST', 'Command payload must be an object.');
  }
  if (command.type === 'layer.add_text' || command.type === 'layer.update_text') {
    if (typeof p.text !== 'string' || p.text.length > MAX_TEXT_LENGTH) {
      throw new EditorBridgeError('INVALID_REQUEST', `text must be a string up to ${MAX_TEXT_LENGTH} characters.`);
    }
    if (command.type === 'layer.update_text' && (typeof p.layerId !== 'string' || !p.layerId)) {
      throw new EditorBridgeError('INVALID_REQUEST', 'layerId is required.');
    }
    if (command.type === 'layer.add_text' && (!Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      throw new EditorBridgeError('INVALID_REQUEST', 'x and y must be finite numbers.');
    }
  }
  if (command.type === 'layer.set_visibility' &&
      (typeof p.layerId !== 'string' || !p.layerId || typeof p.visible !== 'boolean')) {
    throw new EditorBridgeError('INVALID_REQUEST', 'layerId and boolean visible are required.');
  }
  if (command.type === 'layer.reorder' &&
      (typeof p.layerId !== 'string' || !p.layerId || !Number.isSafeInteger(p.toIndex) || p.toIndex < 0)) {
    throw new EditorBridgeError('INVALID_REQUEST', 'layerId and non-negative integer toIndex are required.');
  }
  if (command.type === 'layer.set_transform') {
    if (typeof p.layerId !== 'string' || !p.layerId) throw new EditorBridgeError('INVALID_REQUEST', 'layerId is required.');
    for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg']) {
      if (p[key] !== undefined && !Number.isFinite(p[key])) throw new EditorBridgeError('INVALID_REQUEST', `${key} must be finite.`);
    }
    for (const key of ['scaleX', 'scaleY']) {
      if (p[key] !== undefined && p[key] <= 0) throw new EditorBridgeError('INVALID_REQUEST', `${key} must be positive.`);
    }
  }
}

function validateState(state, editorInstanceId) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.editorInstanceId !== editorInstanceId || typeof state.documentId !== 'string' ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !state.canvas || !Number.isFinite(state.canvas.width) || !Number.isFinite(state.canvas.height) ||
      !Array.isArray(state.layers)) {
    throw new EditorBridgeError('EDITOR_ERROR', 'Editor returned an invalid state snapshot.');
  }
  return state;
}

function withTimeout(promise, timeoutMs, timeoutError) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), timeoutMs);
    }),
  ]);
}

export function createEditorBridge({ transport, timeoutMs = DEFAULT_TIMEOUT_MS, allowedOrigin }) {
  if (!transport || typeof transport.request !== 'function') throw new TypeError('transport.request is required');
  const completed = new Map();
  const inFlight = new Map();
  const uncertain = new Map();

  async function request(type, payload, { timeoutCode = 'EDITOR_TIMEOUT' } = {}) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    try {
      const timeoutError = new EditorBridgeError(
        timeoutCode,
        timeoutCode === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN'
          ? 'Editor command timed out; its outcome is unknown. Query the same commandId before deciding next steps.'
          : 'Editor did not respond within the request timeout.',
        timeoutCode === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' ? { commandId: payload.commandId } : {},
      );
      return await withTimeout(Promise.resolve().then(() => transport.request({
        type, requestId, ...payload,
      }, { timeoutMs, allowedOrigin })), timeoutMs, timeoutError);
    } catch (error) {
      if (error instanceof EditorBridgeError) throw error;
      if (error?.code && typeof error.code === 'string') {
        throw new EditorBridgeError(error.code, error.message || 'Editor request failed.', { revision: error.revision });
      }
      throw new EditorBridgeError('EDITOR_ERROR', error?.message || 'Editor request failed.');
    }
  }

  return {
    async readState(input) {
      validateEnvelope(input);
      const state = validateState(await request('editor.read_state', {
        editorInstanceId: input.editorInstanceId,
      }), input.editorInstanceId);
      if (input.documentId && state.documentId !== input.documentId) {
        throw new EditorBridgeError('DOCUMENT_MISMATCH', 'The active editor document changed.');
      }
      return state;
    },

    async getCommandResult(input) {
      validateEnvelope(input);
      if (typeof input.commandId !== 'string' || input.commandId.length < 1 || input.commandId.length > 256) {
        throw new EditorBridgeError('INVALID_REQUEST', 'commandId must be a non-empty string.');
      }
      const response = await request('editor.get_command_result', {
        editorInstanceId: input.editorInstanceId,
        commandId: input.commandId,
      });
      if (!response || !['applied', 'rejected', 'unknown'].includes(response.status) ||
          (response.originalResult !== null && typeof response.originalResult !== 'object')) {
        throw new EditorBridgeError('EDITOR_ERROR', 'Editor returned an invalid command status.');
      }
      const key = `${input.editorInstanceId}\u0000${input.commandId}`;
      if (response.status === 'applied' && response.originalResult) {
        completed.set(key, response.originalResult);
        uncertain.delete(key);
      }
      // unknown never permits replay. Rejected outcomes are reported to the caller;
      // this adapter does not invent a not-applied retry authorization.
      return response;
    },

    async applyCommand(input) {
      validateEnvelope(input, { command: true });
      validateCommand(input.command);
      if (typeof input.commandId !== 'string' || input.commandId.length < 1 || input.commandId.length > 256) {
        throw new EditorBridgeError('INVALID_REQUEST', 'commandId must be a non-empty string.');
      }
      const key = `${input.editorInstanceId}\u0000${input.commandId}`;
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      if (uncertain.has(key)) {
        throw uncertain.get(key);
      }
      const operation = (async () => {
        const result = await request('editor.apply_command', {
          editorInstanceId: input.editorInstanceId,
          documentId: input.documentId,
          expectedRevision: input.expectedRevision,
          commandId: input.commandId,
          command: input.command,
        }, { timeoutCode: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
        if (!result || result.documentId !== input.documentId || result.commandId !== input.commandId ||
            !Number.isSafeInteger(result.revision) || result.revision <= input.expectedRevision ||
            !Array.isArray(result.changedLayerIds)) {
          throw new EditorBridgeError('EDITOR_ERROR', 'Editor returned an invalid command result.');
        }
        completed.set(key, result);
        return result;
      })();
      inFlight.set(key, operation);
      try { return await operation; }
      catch (error) {
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error);
        throw error;
      }
      finally { inFlight.delete(key); }
    },
  };
}

export function registerEditorTools({ tools, defineTool, transport, timeoutMs, allowedOrigin }) {
  if (!tools || typeof tools.register !== 'function' || typeof defineTool !== 'function') {
    throw new TypeError('tools.register and defineTool are required');
  }
  const bridge = createEditorBridge({ transport, timeoutMs, allowedOrigin });
  const readParameters = {
    type: 'object', additionalProperties: false,
    properties: {
      editorInstanceId: { ...string('Opaque id of the mounted editor frame.'), required: true },
      documentId: string('Optional expected open document id.'),
    },
  };
  const commandParameters = {
    type: 'object', additionalProperties: false,
    properties: {
      editorInstanceId: { ...string('Opaque id of the mounted editor frame.'), required: true },
      documentId: { ...string('Stable id of the open project.'), required: true },
      expectedRevision: { ...integer('Revision returned by editor_read_state.'), required: true },
      commandId: { ...string('Unique idempotency key for this command.'), required: true },
      command: { type: 'object', required: true, additionalProperties: true },
    },
  };
  tools.register(defineTool({
    name: 'editor_read_state',
    description: 'Read the active image editor document, revision, selected layer and layer summaries.',
    parameters: readParameters, output: OUTPUT,
    execute: (args) => bridge.readState(args),
  }));
  tools.register(defineTool({
    name: 'editor_apply_command',
    description: 'Submit one allowlisted structured edit. The editor must atomically check expectedRevision; a timeout means outcome unknown.',
    parameters: commandParameters, output: OUTPUT,
    execute: (args) => bridge.applyCommand(args),
  }));
  tools.register(defineTool({
    name: 'editor_get_command_result',
    description: 'Query the editor-owned outcome of a command by the same editorInstanceId and commandId; unknown does not authorize replay.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        editorInstanceId: { ...string('Opaque id of the mounted editor frame.'), required: true },
        commandId: { ...string('Original idempotency key of the command.'), required: true },
      },
    }, output: OUTPUT,
    execute: (args) => bridge.getCommandResult(args),
  }));
  return bridge;
}
