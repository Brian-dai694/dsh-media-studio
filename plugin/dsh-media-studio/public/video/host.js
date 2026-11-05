// Trusted same-origin parent for the packaged video editor.
// It only registers the editor on the plugin relay; every write goes through the
// model-facing media_video_* tools, never through this page.
import { createIframeTransport } from '/media/host/iframe-transport.mjs';
import { startBrowserRelay } from '/media/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const fail = error => {
  $('status').textContent = `连接失败：${error?.code || 'UI_ERROR'} · ${error?.message || '未知错误'}`;
};

let accessToken = null;
let relay = null;
let transport = null;
let connecting = null;

async function boot() {
  if (accessToken) return accessToken;
  const response = await fetch('/media/boot', { credentials: 'same-origin' });
  if (!response.ok) throw Object.assign(new Error('无法获取本地 harness 令牌'), { code: 'BOOT_FAILED' });
  accessToken = (await response.json()).accessToken;
  return accessToken;
}

async function connect() {
  if (relay) return relay;
  if (connecting) return connecting;
  connecting = (async () => {
    await boot();
    transport = createIframeTransport({ iframe: $('editor'), origin: location.origin });
    relay = await startBrowserRelay({
      transport,
      accessToken,
      baseUrl: '/media/video-relay',
      editorKind: 'video',
      onError: error => { $('status').textContent = `连接异常：${error.message}；原命令结果可能未知，请用原 commandId 查询`; },
    });
    $('status').textContent = `已连接 · 实例 ${relay.editorInstanceId} · page ${relay.pageId} · 写入入口为 media_video_* 工具`;
    return relay;
  })();
  try { return await connecting; } finally { connecting = null; }
}

async function reconnect() {
  await relay?.stop();
  relay = null;
  await connect();
}

for (const [id, action] of [['connect', connect], ['reconnect', reconnect]]) {
  $(id).addEventListener('click', () => void action().catch(fail));
}

// Embedded as a sidebar panel there is no one to press "connect": bind on load so the
// editor is registered with the relay before the user or the model touches it.
$('editor').addEventListener('load', () => {
  if (relay) return;
  $('status').textContent = '编辑器已加载，正在自动连接 video relay…';
  void connect().catch(fail);
});
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'media.binding.read') return;
  const requestId = event.data.requestId;
  try {
    const connection = await connect();
    const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    parent.postMessage({ type: 'media.binding.result', requestId, binding: { editorKind: 'video', projectId: state.documentId, documentId: state.documentId, editorInstanceId: connection.editorInstanceId, pageId: connection.pageId } }, location.origin);
  } catch (error) {
    parent.postMessage({ type: 'media.binding.result', requestId, error: error.message }, location.origin);
  }
});
window.addEventListener('pagehide', () => { void relay?.stop(); });
