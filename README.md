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

# miniPaint 图片页
cd miniPaint/miniPaint-master && npm install && npm run build
```

打包产物（`plugin/dist/*.tgz`）与 `node_modules` 不入库。

## 已知限制

- 视频导出音画合成、工程重开与媒体重连仍需真实媒体验收。
- 审批等待受宿主工具超时约束，修复后需重新发起一次授权。
- 部分能力（极简布局、结果卡撤销按钮）默认关闭，待验收后开放。
