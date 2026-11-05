# DSH Media Studio — 图片 / 视频人机协作编辑器

DeepSeek Harness 插件原型：左侧原生编辑器（图片用 miniPaint，视频用原生 video/Canvas），
右侧是**真实 DSH 会话**（`ctx.remote.session.prompt/follow`），人和 Agent 共享同一份原生工程状态。

## 目录

| 目录 | 内容 |
| --- | --- |
| `plugin/dsh-media-studio` | DSH 插件：Host 工具（tools/bridge/gate/relay）、client 双入口、iframe transport |
| `miniPaint/miniPaint-master` | 中文 miniPaint 底座（Apple 主题、原生历史桥、PNG/JPEG 导出） |
| `video` | 视频编辑器 MVP（单轨剪辑、文字/图片叠加、撤销重做、WebM 合成导出） |
| `host` | 宿主页与 iframe transport |
| `contracts` | `editor-bridge.v1` 契约、会话/审批接口核查记录 |

## 协作模型

- 状态由编辑器唯一持有；Host 只做白名单命令、`expectedRevision`、`commandId` 防重与审计。
- 写入后立即回读校验；结果未知记为 `unknown` 并禁止重放。
- 定向撤销需 `commandId + afterDigest + revision + 历史栈顶` 全部匹配，否则 `HISTORY_CONFLICT`。
- 首次绑定：真实工具 `exec` 身份 + 原生审批 `allowed-once` + 审批前后页面/工程/快照一致，Host 才登记。
  客户端自报 `sessionId` 不参与授权。

## 构建与测试

```bash
# 插件
cd plugin/dsh-media-studio && pnpm install && node --test test/*.test.mjs

# 视频编辑器（状态 / 桥 / 页面 / 打包一致性）
cd video && node tests/video-bridge.test.mjs && node tests/video-state.test.mjs \
  && node tests/video-page.test.mjs && node tests/video-package.test.mjs

# miniPaint 图片页
cd miniPaint/miniPaint-master && npm install && npm run build
```

打包产物（`plugin/dist/*.tgz`）与 `node_modules` 不入库。

## 视频导出格式

导出走单 Canvas 合成 + `MediaRecorder`：把源画面（按裁切区间）、处于 `[start, end)` 的文字/图片叠加，
以及源音轨合成一条流，录制为 **WebM**；无音轨素材会如实标注「素材无音轨」。

**MP4 未验证，暂不可用**：页面显示「MP4 未验证」，导出工具收到 `format=mp4` 会返回
`EXPORT_FORMAT_UNAVAILABLE`，不会静默降级或谎报成功。

## 已知限制

- 视频导出（音画合成、真实播放校验）、工程重开与媒体重连仍需真实媒体验收；当前只有静态与桥级测试证据。
- 媒体不嵌入工程快照，重开工程需重新选择同一源视频（按 `sourceRef` 自动重连，不新建片段）。
- 审批等待受宿主工具超时约束，修复后需重新发起一次授权。
- 部分能力（极简布局、结果卡撤销按钮）默认关闭，待验收后开放。
