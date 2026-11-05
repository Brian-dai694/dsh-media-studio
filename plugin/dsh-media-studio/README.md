# dsh-media-studio（Host + client 插件）

图片 + 视频共享编辑的 DSH 插件：Host 侧注册工具与同源路由，client 侧只加两个侧栏入口；不启动自己的 HTTP 服务，relay 是工具内部实现。

## 侧栏入口（client）

`lib/client.js` 用官方槽位注册两条入口，别的一律不注册：

| 入口 id | 标签 | `sidebar.panellist` | `main` 内容 |
|---|---|---|---|
| `media-image-editor` | 图片编辑器 | 按钮，点击 `layout.selectPanel(id)` | iframe `/media/image/host.html` |
| `media-video-editor` | 视频编辑器 | 同上 | iframe `/media/video-host/` |

协作宿主页**不作为入口暴露**：它被面板 iframe 包住，并在 iframe `load` 时自动连 relay，用户不需要先点「连接」。`media_image_*` / `media_video_*` 工具仍是唯一写入面。

## 内容

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：`name` / `inject` / `apply(ctx, config)`，注册工具、guard、路由 |
| `lib/client.js` | 浏览器侧 Cordis 模块：两个侧栏入口 + 两个内容面板 |
| `lib/tools.js` | 8 个模型的工具（DSL 参数表 + 四态 `output.schema` + `presentationMeta`） |
| `lib/gate.js` | 同步 guard、autonomous capability 表、高风险 operation 表、pending→approvalId 绑定 |
| `lib/bridge.js` | 编辑器适配器：状态校验、`expectedRevision`、`commandId` 幂等、超时 unknown、导出 |
| `lib/http.js` | `/media/*` 路由：boot token、relay 传输、静态页、穿越防护 |
| `lib/relay.js` | 编辑器 relay（租约、认证、大小上限、页面绑定） |
| `public/video/` | 打包的视频编辑器页与 wrapper（`/media/video/`、`/media/video-host/`） |
| `public/host/` | 同源 iframe transport 与浏览器 relay（`/media/host/`） |
| `public/image/` | 打包的 miniPaint 图片页（`/media/image/`），由 `scripts/pack-image.mjs` 生成 |
| `scripts/pack-image.mjs` | 从 miniPaint 构建产物打包运行时资产，产出 `BUILD.json` 清单 |

### 图片页打包

```powershell
npm run pack:image                      # 默认读 ../../miniPaint/miniPaint-master
node scripts/pack-image.mjs <源> <目标>  # 显式指定
```

只打包运行时资产：`index.html`、`dist/bundle.js`、`images/**`（排除 `preview.*` 与 `manifest/`、`*.map`、`*.bak-*`），并把 `scripts/image-page/host.html`+`host.js` 一并写入产物根目录。源目录只读；`public/image/BUILD.json` 记录每个文件的字节数、sha256 与来源（`miniPaint` / `plugin`），`bundleSha256` 用于确认打包的是哪次构建。`imageRoot` 未配置时默认使用 `public/image`（存在 `index.html` 才启用），显式配置仍优先。

图片页入口：`/media/image/` 是编辑器本体，`/media/image/host.html` 是协作宿主——它取 `/media/boot` 令牌，把编辑器经 MessageChannel 绑定到 `/media/image-relay`（`editorKind=image`）。工具调用只发生在模型会话里，宿主页不直连工具、不写工程文件。

## 工具

| 工具 | editorKind | 说明 |
|---|---|---|
| `media_image_read_state` | image | 读工程状态、revision、digest、图层、原生撤销栈 |
| `media_image_apply_command` | image | 白名单 `layer.*` 写入 |
| `media_image_get_command_result` | image | 按原 `commandId` 查询结果 |
| `media_image_export_start` | image | 导出 png/jpeg；不改 revision、不进撤销历史 |
| `media_image_export_status` | image | 查询导出状态；小图可能直接 `ready` |
| `media_video_read_state` | video | 读时间轴、轨道、片段、叠加、能力 |
| `media_video_apply_command` | video | 白名单 `media.video.*` 写入；高风险先返回 `pending` |
| `media_video_get_command_result` | video | 按原 `commandId` 查询结果 |
| `media_video_export_start` | video | 异步导出，只返回 `exportId` |
| `media_video_export_status` | video | 查询导出状态与 `artifactRef` |

## 路由

`/media/boot`（同源 token）、`/media/video/`、`/media/video-host/`、`/media/host/*`、`/media/image/`（需 `imageRoot`）、`/media/image-relay/*`、`/media/video-relay/*`。
**没有** `/prototype-tools`、`/video-tools` 这类 HTTP 工具面——工具只能经 `ctx.tools` 调用。

## 安装到隔离 profile

```powershell
dsh plugin --profile diagram-test add "file:<本包绝对路径>"
```

插件自带 `cordis.patch.yml`，`dsh` 会把它作为 bundle patch 自动插入一行；**不要**在 profile 的 `cordis.patch.yml` 里再手工加一行，否则会出现重复 `id`（已实测）。

核对：

```powershell
dsh --profile diagram-test --dump-config | Select-String 'dsh-media-studio' -Context 1,4
```

回滚：

```powershell
dsh plugin --profile diagram-test remove dsh-media-studio
```

## 已验证 / 未验证（如实）

**已验证**
- 包能被 `dsh plugin --profile diagram-test add` 装进隔离 profile，`--dump-config` 合成出该行。
- 从 profile 的 `node_modules/dsh-media-studio` 真实加载，`apply(fakeCtx)` 注册 **10 个工具 + 1 个 guard + 1 条 `prefix /media` 路由**。
- 13 项本地测试通过：工具清单与四态 schema、guard 静态拒绝、`/media/boot` 同源限制、无 HTTP 工具面、relay 认证与未知动作、幂等合并、超时 unknown 不重放、审批绑定（会话/项目/payload/rev/digest、单次、TTL）、过期审批。
- 10 个工具定义能被本机 0.2.0-rc.2 的真 `defineTool` 接受；`params: {type:'json'}` 编译为注解节点（`{}`），必填与枚举正确。

**导出契约**：`export_start` 记录 `sourceRevision` + `stateDigest` 并返回 `exportId`；`export_status` 返回 `queued|running|ready|completed|failed|unknown` 与 `artifactRef`。导出不改工程 revision、不进撤销历史；超时同样记 `unknown`，用原 `exportId` 查询。

**未验证**
- 真实 DSH 会话里工具是否出现在模型工具表、审批 UI 是否可交互（需要启动隔离 profile 的 GUI，本轮未启动）。
- `/media/*` 路由在真实 `ctx.webServer` 下的可达性（同上）。
- 浏览器里人机闭环（导入/预览/撤销/重做/导出）。
- 桌面运行时 0.2.1-rc.5 的逐条契约一致性。

## 版本与 peer

`package.json` 的 peer 写 `@deepseek-ai/dsh-tools >=0.2.0-rc.2 <0.3.0`、`@deepseek-ai/cordis >=4.0.4 <5.0.0`。

原因（实测）：写死 `0.2.1-rc.2` 时，CLI（0.2.0-rc.2 树）直接拒绝安装：

```
dsh: installation rejected: Plugin dsh-media-studio@0.0.1 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-tools":"0.2.1-rc.2"}.
```

放宽到区间后安装通过（pnpm 只报 peer warning）。桌面运行时 0.2.1-rc.5 的兼容性未逐条验证。

## 已知限制

- `unknown` 记录保存在插件内存，进程重启后丢失；此时只能依赖编辑器自身的 `commandId` 记录。
- `imageRoot` 未配置且 `public/image/index.html` 不存在时，`/media/image/` 返回 503 `IMAGE_PAGE_UNAVAILABLE`（当前包已附带打包产物，默认即可用）。
- 图片导出工具已注册，但编辑器页面尚未实现 `editor.export_start/status` 应答，实际导出未验证。
- `apply` 未导出 `Config` schema（避免对 `schemastery` 的 peer 依赖）；`dataDir` / `imageRoot` 由 patch 行直接注入。
- 审批在 `execute` 内进行，要求 open turn；`diagram-test` 无 answerer 时高风险写入返回拒绝，属预期 fail-closed。
