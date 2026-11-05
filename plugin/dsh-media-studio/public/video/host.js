// Trusted same-origin parent for the video plugin prototype.
// Speaks to the editor only through the MessageChannel transport; every write goes
// through /video-tools (local harness adapter), never through direct state access.
import { createIframeTransport } from '/host/iframe-transport.mjs';
import { startBrowserRelay } from '/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const show = value => { $('output').textContent = JSON.stringify(value, null, 2); };
const fail = error => show({ code: error.code || 'UI_ERROR', message: error.message, ...(error.revision !== undefined ? { revision: error.revision } : {}), ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) });

let accessToken = null;
let transport = null;
let relay = null;
let connecting = null;
let lastIntent = null;
let lastCommand = null;

async function boot() {
  if (accessToken) return accessToken;
  const response = await fetch('/boot', { credentials: 'same-origin' });
  if (!response.ok) throw Object.assign(new Error('无法获取本地 harness 令牌'), { code: 'BOOT_FAILED' });
  accessToken = (await response.json()).accessToken;
  return accessToken;
}

async function callTool(name, args) {
  const token = await boot();
  const response = await fetch('/video-tools', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args }) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message || '本地工具调用失败'), { code: value.code });
  if (!value.ok) throw Object.assign(new Error(value.error?.message || '本地工具返回失败'), value.error || {});
  return value.result;
}

async function connect() {
  if (relay) return relay;
  if (connecting) return connecting;
  connecting = (async () => {
    await boot();
    transport = createIframeTransport({ iframe: $('editor'), origin: location.origin });
    relay = await startBrowserRelay({
      transport, accessToken, baseUrl: '/video-relay', editorKind: 'video',
      onError: error => { $('status').textContent = `连接异常：${error.message}；原命令结果可能未知，请用原 commandId 查询`; }
    });
    $('status').textContent = `已连接本地 harness · 实例 ${relay.editorInstanceId} · page ${relay.pageId}`;
    return relay;
  })();
  try { return await connecting; } finally { connecting = null; }
}

async function readState() {
  const connection = await connect();
  const state = await callTool('media.video.read_state', { editorInstanceId: connection.editorInstanceId });
  show(state);
  return state;
}

async function prepareIntent() {
  const connection = await connect();
  const state = await callTool('media.video.read_state', { editorInstanceId: connection.editorInstanceId });
  const text = $('text').value.trim();
  if (!text) throw new Error('请先填写叠加文字');
  const durationUs = Math.max(1_000_000, Math.round(state.timeline.duration * 1_000_000));
  const intent = {
    editorInstanceId: connection.editorInstanceId,
    intentId: crypto.randomUUID(),
    projectId: state.projectId,
    editorKind: 'video',
    action: '添加文字叠加',
    payload: { kind: 'text', text, startUs: 0, durationUs },
    targets: [],
    expectedRevision: state.revision,
    mode: 'conversation',
    actor: 'local-harness-user',
    reason: '本地 harness 预览：添加文字叠加'
  };
  const preview = await callTool('media.video.prepare_intent', intent);
  lastIntent = preview;
  lastCommand = { editorInstanceId: connection.editorInstanceId, commandId: preview.idempotencyKey };
  $('approve').disabled = false;
  show(preview);
}

async function approveIntent() {
  if (!lastIntent) throw new Error('请先生成意图预览');
  const connection = await connect();
  const result = await callTool('media.video.execute_approved', {
    editorInstanceId: connection.editorInstanceId,
    approvalId: lastIntent.approvalId,
    auditRef: `local-audit-${crypto.randomUUID()}`,
    confirmed: true,
    capabilities: []
  });
  $('approve').disabled = true;
  show(result);
  await readState();
}

async function queryResult() {
  if (!lastCommand) throw new Error('尚未提交命令');
  show(await callTool('media.video.get_command_result', lastCommand));
}

async function reconnect() {
  const previous = relay?.editorInstanceId;
  await relay?.stop();
  relay = null;
  const current = await connect();
  if (previous && previous !== current.editorInstanceId) {
    show({ status: 'unknown', message: '编辑器实例已变化；原命令结果未知，禁止自动重放，请用原 commandId 查询', originalCommand: lastCommand });
  }
}

for (const [id, action] of [['connect', connect], ['reconnect', reconnect], ['read', readState], ['prepare', prepareIntent], ['approve', approveIntent], ['query', queryResult]]) {
  $(id).addEventListener('click', () => void action().catch(fail));
}
$('editor').addEventListener('load', () => { if (!relay) $('status').textContent = '编辑器已加载；点击“连接编辑器”建立本地 harness 通道。'; });
window.addEventListener('pagehide', () => { void relay?.stop(); });
