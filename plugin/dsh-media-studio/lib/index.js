// DSH Host plugin entry: image + video shared-editing tools and same-origin pages.
// Tools are the only model-facing write surface; relay is an internal transport.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorRelay } from './relay.js';
import { createMediaBridge } from './bridge.js';
import { createGuard, createApprovalStore } from './gate.js';
import { registerMediaTools } from './tools.js';
import { createMediaRouter } from './http.js';

export const name = 'dsh-media-studio';
export const inject = ['tools', 'webServer', 'approval'];

// Config is supplied by the profile patch row; no schemastery peer is required here.
// Recognized keys: dataDir (reserved) and imageRoot (optional packaged image build).

const hostRoot = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(hostRoot, '../public');
// The image page is a build artifact of this package; an explicit config.imageRoot still wins.
const packagedImageRoot = resolve(publicDir, 'image');

export function apply(ctx, config = {}) {
  const token = randomBytes(32).toString('hex');
  const imageRelay = createEditorRelay({
    editorKind: 'image',
    allowedTypes: ['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status'],
  });
  const videoRelay = createEditorRelay({
    editorKind: 'video',
    allowedTypes: ['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status'],
  });
  const imageBridge = createMediaBridge({ relay: imageRelay, editorKind: 'image' });
  const videoBridge = createMediaBridge({ relay: videoRelay, editorKind: 'video' });
  const approvals = createApprovalStore();

  ctx.effect(() => () => { imageRelay.close(); videoRelay.close(); }, 'media-studio: relay dispose');

  ctx.tools.guard(createGuard());

  const router = createMediaRouter({
    imageRelay,
    videoRelay,
    token,
    publicDir,
    imageRoot: config.imageRoot ? resolve(config.imageRoot)
      : existsSync(join(packagedImageRoot, 'index.html')) ? packagedImageRoot : null,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/media', handler: router }), 'media-studio: /media');

  registerMediaTools(ctx, { imageBridge, videoBridge, approvals });
  return { dispose() { imageRelay.close(); videoRelay.close(); } };
}
