// Probe: does the real 0.2.0-rc.2 defineTool accept this plan's DSL parameter tables?
// Read-only: no profile change, no plugin install. Run: node plugin/dsl-probe.mjs
import { pathToFileURL } from 'node:url';

const TOOLS_ENTRY = 'C:/Users/UEFR/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
const { defineTool } = await import(pathToFileURL(TOOLS_ENTRY).href);

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['applied', 'rejected', 'pending', 'unknown'] },
    commandId: { type: 'string', required: true },
    revision: { type: 'integer' },
    stateDigest: { type: 'string' },
    canUndo: { type: 'boolean' },
    canRedo: { type: 'boolean' },
    approvalId: { type: 'string' },
    auditRef: { type: 'string' },
    error: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
      retryable: { type: 'boolean' },
    } },
  },
};

const writeParams = kind => ({
  editorKind: { type: 'string', required: true, enum: ['image', 'video'] },
  projectId: { type: 'string', required: true },
  instanceId: { type: 'string' },
  commandId: { type: 'string', required: true },
  expectedRevision: { type: 'integer', required: true },
  mode: { type: 'string', enum: ['assist', 'autonomous'] },
  operation: { type: 'string', required: true },
  targets: { type: 'array', items: { type: 'string' } },
  params: { type: 'json' },
  approvalId: { type: 'string' },
});

const readParams = { instanceId: { type: 'string' }, editorKind: { type: 'string', enum: ['image', 'video'] } };

const tools = [
  ['media_image_read_state', readParams],
  ['media_image_apply_command', writeParams('image')],
  ['media_image_get_command_result', { ...readParams, commandId: { type: 'string', required: true } }],
  ['media_image_export_start', { ...readParams, projectId: { type: 'string', required: true }, commandId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true }, format: { type: 'string', required: true, enum: ['png', 'jpeg'] } }],
  ['media_image_export_status', { ...readParams, exportId: { type: 'string', required: true } }],
  ['media_video_read_state', readParams],
  ['media_video_apply_command', writeParams('video')],
  ['media_video_get_command_result', { ...readParams, commandId: { type: 'string', required: true } }],
  ['media_video_export_start', { ...readParams, projectId: { type: 'string', required: true }, commandId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true }, format: { type: 'string', required: true, enum: ['webm', 'mp4'] } }],
  ['media_video_export_status', { ...readParams, exportId: { type: 'string', required: true } }],
];

const results = [];
for (const [name, parameters] of tools) {
  try {
    const def = defineTool({
      name,
      description: `${name}（DSL 探针）`,
      parameters,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `${name}: ${value.status ?? 'ok'}` }],
        presentationMeta: (args, value) => ({ operation: args.operation, status: value.status }),
      },
      async execute() { return { status: 'rejected', commandId: 'probe' }; },
    });
    const props = def.parameters?.properties ?? def.schema?.properties ?? {};
    results.push({ name, ok: true, properties: Object.keys(props).sort() });
  } catch (error) {
    results.push({ name, ok: false, error: `${error.name}: ${error.message}` });
  }
}

// Compile check: the `json` node must project into the wire schema without a `type` keyword.
const sample = defineTool({
  name: 'media_video_apply_command',
  description: 'sample',
  parameters: writeParams('video'),
  output: { schema: RESULT_SCHEMA, render: () => [{ type: 'text', text: 'ok' }] },
  async execute() { return { status: 'rejected', commandId: 'probe' }; },
});
const wire = sample.parameters ?? sample.schema ?? {};
const compiles = {
  rootType: wire.type,
  paramsNode: wire.properties?.params,
  targetsNode: wire.properties?.targets,
  required: wire.required,
  modeEnum: wire.properties?.mode?.enum,
};

console.log(JSON.stringify({ toolCount: tools.length, ok: results.filter(r => r.ok).length, results, compiles }, null, 2));
