import { createIframeTransport } from './iframe-transport.mjs';
import { startBrowserRelay } from './browser-relay.mjs';
const $ = (id) => document.getElementById(id);
let transport, relay, accessToken, snapshot;
let lastCommand;
let connecting;
const show = (value) => { $('output').textContent = JSON.stringify(value, null, 2); };
async function connect() {
  if (relay) return relay;
  if (connecting) return connecting;
  connecting = (async () => {
    accessToken = (await (await fetch('/boot')).json()).accessToken;
    transport = createIframeTransport({ iframe: $('editor'), origin: location.origin });
    relay = await startBrowserRelay({ transport, accessToken, onError: (error) => { $('status').textContent = `连接异常：${error.message}；原命令结果可能未知`; } });
    $('status').textContent = `已连接隔离中继 · 实例 ${relay.editorInstanceId} · 页面 ${relay.pageId}`;
    return relay;
  })();
  try { return await connecting; } finally { connecting = null; }
}
async function invoke(name, args) {
  await connect();
  const response = await fetch('/prototype-tools', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ name, args }) });
  const value = await response.json();
  show(value);
  if (!value.ok) throw Object.assign(new Error(value.error?.message || '调用失败'), value.error);
  return value.result;
}
async function read() {
  const connection = await connect();
  snapshot = await invoke('editor_read_state', { editorInstanceId: connection.editorInstanceId });
  show(snapshot);
}
async function update(stale) {
  if (!snapshot?.selectedLayerId) throw new Error('请在编辑器选中文字层后读取工程');
  const commandId = crypto.randomUUID();
  $('commandId').value = commandId;
  lastCommand = { editorInstanceId: relay.editorInstanceId, commandId };
  await invoke('editor_apply_command', { editorInstanceId: relay.editorInstanceId, documentId: snapshot.documentId,
    expectedRevision: stale ? Math.max(0, snapshot.revision - 1) : snapshot.revision, commandId,
    command: { type: 'layer.update_text', payload: { layerId: snapshot.selectedLayerId, text: $('text').value } } });
}
async function reconnect() {
  const previousInstance = relay?.editorInstanceId;
  await relay?.stop();
  relay = null;
  const current = await connect();
  if (previousInstance && previousInstance !== current.editorInstanceId) {
    snapshot = null;
    show({ status: 'unknown', message: '编辑器已变化；旧命令标识已保留，结果未知，禁止自动重放', originalCommand: lastCommand });
  }
}
for (const [id, action] of [['connect', connect], ['reconnect', reconnect], ['read', read], ['update', () => update(false)], ['stale', () => update(true)], ['query', () => {
  if (!lastCommand) throw new Error('尚未提交命令');
  return invoke('editor_get_command_result', lastCommand);
}]]) {
  $(id).addEventListener('click', () => void action().catch((error) => show({ code: error.code || 'UI_ERROR', message: error.message })));
}
$('editor').addEventListener('load', () => { $('status').textContent = '编辑器已加载，请点击连接编辑器'; });
window.addEventListener('pagehide', () => { void relay?.stop(); });
