# DSH Host 插件实现方案（Media Studio · 图片 + 视频）

状态：**方案文档，未创建插件包、未装载 profile、未改 desktop/web 生产。**
编写：ODE。依据：本机 `dsh --version` = 0.2.0-rc.2（CLI）+ REA 读到的桌面运行时 0.2.1-rc.5；契约以可读的 0.2.0-rc.2 包为准。

---

## 1. 事实基线（本机实测，非推测）

| 项 | 实测值 | 证据 |
|---|---|---|
| CLI | `0.2.0-rc.2` | `dsh --version` |
| CLI 依赖树 | `@deepseek-ai/dsh-tools@0.2.0-rc.2`、`dsh-user-approval@0.2.0-rc.2`、`dsh-host-webserver@0.2.0-rc.2`、`cordis@4.0.4`、`schemastery@3.18.4` | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` |
| 桌面运行时 | `0.2.1-rc.5`（REA 读 `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`） | REA 回报；app.asar 不可读 |
| 隔离 profile | `~/.dsh/profiles/diagram-test` 已存在 | 见下 |
| 生产 profile | `desktop` / `web` — **本方案不触碰** | — |

`diagram-test` 现状（读自该目录）：

- `package.json`：`dsh-profile-diagram-test`，唯一依赖 `dsh-diagram-studio@file:...0.3.2.tgz`，`dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`。
- `cordis.patch.yml`：`- insert: [{ id: dsh-diagram-studio, name: dsh-diagram-studio, config: { dataFile: !!js dshHomePath('diagram-studio-test/diagrams.json') } }]` + 一条 `ui-settings-general` 覆盖。
- `dsh --profile diagram-test --dump-config` 能正确合成出该行，说明 **profile 隔离装载链路本身已验证可用**。

真实插件形态（`dsh-diagram-studio@0.3.4`，本机可读）：

- `package.json`：`main: lib/index.js`、`type: module`、`dsh.bundle.patch: ./cordis.patch.yml`。
- `lib/index.js` 导出：`name`（= 包名）、`inject: ['tools','webServer']`、`apply(ctx, config)`。
- `ctx.tools.register(defineTool({...}))`；`ctx.effect(() => ctx.webServer.register({kind, path, handler}), label)`。

工具 DSL（`@deepseek-ai/dsh-tools@0.2.0-rc.2` 官方 README 与 `lib/types/schema.d.ts`）：

```js
ctx.tools.register(defineTool({
  name: 'read_file',
  description: '…',
  parameters: {                       // DSL 属性表，不是 JSON Schema
    path: { type: 'string', required: true, description: '…' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },       // 这里才是原始 JSON Schema
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) { … },
}))
```

- DSL 支持 `string / number / integer / boolean / null / array / object / json / oneOf`；
  嵌套对象 = `{ type:'object', additionalProperties:false, properties:{…} }`；
  自由 JSON = `{ type:'json' }`（author-only，编译为仅注解 schema）。
- 必填标记是**属性级** `required: true`，不是根级 `required: [...]`。
- `output.render` 必填；`presentationMeta` 可选。
- **Web Client 不再消费 `presentCall/presentResult`**（官方 README 明确写出），UI 由 `toolview` + 持久化 meta 推导 —— 所以审计信息必须写入 `presentationMeta`。

审批（`dsh-user-approval@0.2.0-rc.2` README）：

- `ctx.approval.request({ agent, toolName, callId?, reason, displayReason?, signal })`。
- 结果词表：`allowed-once / rejected / cancelled / unavailable`；**只有 `allowed-once` 放行**。
- 要求 **open turn**：空闲或跨轮调用直接抛错（fail-closed）。
- 无内置 answerer 时返回 `unavailable`；隔离 profile 若没装审批应答方，高风险写入会一律被拒。

---

## 2. 目标与边界

**做**：一个 Host-only 插件包，注册 6 个工具（图片 3 + 视频 3），用 `ctx.webServer` 挂两张编辑页与各自 transport，relay 降为插件内部实现，装进 `diagram-test` 验证真实工具注册。

**不做**（本轮）：
- 不做 client bundle / 侧栏内嵌（2.1 client 槽 API 未验证）。
- 不改 `desktop`、`web` 生产 profile，不改宿主配置。
- 不删原型目录里的 `local-harness` 服务（保留作对照），插件是新增独立包。
- 不宣称已在 0.2.1-rc.5 逐条验证。

---

## 3. 文件清单（新建独立包目录）

根：`diagram-studio-prototype/plugin/dsh-media-studio/`

```
dsh-media-studio/
  package.json                 # main/env/dsh.bundle.patch/peer
  cordis.patch.yml             # 插件自带的 insert 行（bundle 用）
  README.md                    # 装载说明 + 验证清单
  lib/
    index.js                   # name/inject/Config/apply：注册工具 + 路由
    tools.js                   # 6 个 defineTool（DSL 参数、output.schema 四态）
    gate.js                    # guard 静态拒绝 + execute 内 approval + capability 表
    bridge.js                  # EditorBridgeError / 幂等 / uncertain / 超时 unknown（改造自 editor-tools.mjs）
    relay.js                   # 原样搬 host/relay.mjs
    bounded-output.js          # 原样搬 host/bounded-output.mjs
    static.js                  # 静态路由解析 + 穿越防护（搬 video-host-route.mjs 思路）
    http.js                    # relay HTTP 处理器（原 relay.mjs 的 createRelayHttpHandler 部分）
  public/
    image/                     # 图片页（miniPaint 构建产物）
    video/                     # 视频页（现 video/ 子树产物）
  test/
    tools-schema.test.mjs      # DSL 参数表能被 defineTool 接受
    gate.test.mjs              # guard/审批/capability/unknown
    relay.test.mjs             # 幂等/超时/租约/大小限制
    static.test.mjs            # 路径穿越 404、前缀路由
```

### 3.1 `package.json`（草案）

```json
{
  "name": "dsh-media-studio",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "files": ["lib/", "public/", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=22" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2",
    "@deepseek-ai/cordis": "~4.0.5"
  }
}
```

**版本已由 Chief 锁定**：桌面运行时 `0.2.1-rc.5`，peer 写 `dsh-tools 0.2.1-rc.2`、`cordis ~4.0.5`。

**装前必须预检（已知风险，不是推测）**：本机 CLI 依赖树是 `dsh-tools@0.2.0-rc.2`、`cordis@4.0.4`，而 `dsh plugin --profile … add` 走的是 **CLI 侧 pnpm**。peer 写死 `0.2.1-rc.2` 时有两种可能：
- pnpm 只报 `Unmet peer dependency` 警告并继续安装（pnpm 默认行为，**未实测**）；
- 或按严格 peer 直接失败。

装之前先跑一次只读预检，确认真实行为再动 profile：

```powershell
dsh plugin --profile diagram-test add "file:<包绝对路径>" --dry-run
```

若预检报 peer 冲突，有两个不改生产的选择：把 peer 放宽为 `">=0.2.0-rc.2 <0.3.0"`（推荐，README 记录「0.2.0-rc.2 已验证、0.2.1-rc.5 未逐条验证」），或在 `diagram-test` 的 `.npmrc` 里对该 provider 关闭严格 peer 检查（仅隔离 profile）。**最终以预检输出为准，不预先宣称能装进去。**

### 3.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-media-studio
      name: dsh-media-studio
      config:
        dataDir: !!js dshHomePath('media-studio-test')
        approvalPolicy: ask
```

### 3.3 `lib/index.js` 骨架

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerImageTools, registerVideoTools } from './tools.js'
import { createRelay } from './relay.js'
import { mountRoutes } from './static.js'

export const name = 'dsh-media-studio'
export const inject = ['tools', 'webServer', 'approval']

export function apply(ctx, config = {}) {
  const imageRelay = createRelay({ editorKind: 'image' })
  const videoRelay = createRelay({ editorKind: 'video', allowedTypes: [/* + export_* */] })
  ctx.effect(() => () => { imageRelay.close(); videoRelay.close() }, 'media-studio: relay dispose')
  mountRoutes(ctx, config)                       // boot/token + 静态页 + relay HTTP
  registerImageTools(ctx, { relay: imageRelay, config })
  registerVideoTools(ctx, { relay: videoRelay, config })
}
```

**Config 用 schemastery**（与真实插件一致），字段 `.required()`；`dataDir` 由 patch 的 `!!js dshHomePath(...)` 注入。

---

## 4. 接线顺序（严格执行，每步可独立验证）

1. **建包骨架**：`package.json` + `cordis.patch.yml` + 空 `apply`，只导出 `name/inject/apply`。
   *验证*：`node -e "import('./lib/index.js')"` 三个导出存在。
2. **搬 relay/bounded-output**：改 import 路径，不改逻辑。
   *验证*：原 `host/relay.test.mjs` 拷过来跑通。
3. **重写 DSL 参数**：6 个工具全部换成属性表（见 §5）。
   *验证*：真 `defineTool(...)` 接受；`valueSchemaSpecToJsonSchema` 能编译出期望 schema。
4. **门控**：`ctx.tools.guard` 同步拒绝 + `execute` 内 `ctx.approval.request`。
   *验证*：跨 editorKind、缺 capability、无审批放行三类用例。
5. **路由**：`ctx.webServer.register` 挂 `/media/image/*`、`/media/video/*`，boot token 同源下发；**删除** `/prototype-tools`、`/video-tools` 概念。
   *验证*：curl 各路由；穿越路径 404；无 token 403。
6. **装 profile**：`dsh plugin --profile diagram-test add "file:<abs path>"`，再在 `diagram-test/cordis.patch.yml` 加 insert 行。
   *验证*：`dsh --profile diagram-test --dump-config` 出现该行；启动后工具列表出现 6 个。

---

## 5. DSL 参数重写范围（10 个 → 6 个）

现状：`host/editor-tools.mjs` 用 `parameterSchema(...)` + `{type:'object', additionalProperties:false, properties}`，视频 7 个工具同样走 `parameterSchema`。这些在 2.x 一律不合法（`parameters.type must be a value schema object`）。

| 现工具（本地 harness） | 新注册名 | 说明 |
|---|---|---|
| editor_read_state | `media_image_read_state` | 只读，设 timeoutMs |
| editor_apply_command | `media_image_apply_command` | 写，不设 timeoutMs |
| editor_get_command_result | `media_image_get_command_result` | 只读，设 timeoutMs |
| media.video.read_state | `media_video_read_state` | 只读 |
| media.video.apply_command | `media_video_apply_command` | 写 |
| media.video.get_command_result | `media_video_get_command_result` | 只读 |
| media.video.prepare_intent | **并入 apply_command** 的 `mode`/`approvalId` | 预览走工具输出 `pending` |
| media.video.execute_approved | **同上** | 审批在 execute 内做 |
| media.video.export_start | `media_video_export_start` | 异步，返回 exportId |
| media.video.export_status | `media_video_export_status` | 只读 |

**数量口径**：现有本地 harness 共 10 个工具。`prepare_intent` 与 `execute_approved` 合并进 `apply_command`（2 → 0），导出两件保留，**最终注册 8 个**：图片 3 + 视频 5。
合并理由：`prepare_intent → execute_approved` 在真实 DSH 里由「工具返回 `pending` + 用户审批 + 再次调用带 `approvalId`」表达，不必拆成两个工具；拆开会多出一个可被模型直接调用的写入口。
若架构师要求保留独立工具，则回到 10 个，DSL 写法相同，不影响其余设计。

公共参数（所有写工具）：

```js
const WRITE_PARAMS = {
  editorKind:        { type: 'string', required: true, enum: ['image', 'video'] },
  projectId:         { type: 'string', required: true },
  instanceId:        { type: 'string', description: '已连接的编辑器实例 id' },
  commandId:         { type: 'string', required: true, description: '幂等键，重放返回原结果' },
  expectedRevision:  { type: 'integer', required: true },
  mode:              { type: 'string', enum: ['assist', 'autonomous'] },
  operation:         { type: 'string', required: true, description: 'media.image.* / media.video.*' },
  targets:           { type: 'array', items: { type: 'string' } },
  params:            { type: 'json' },
  approvalId:        { type: 'string' }
}
```

只读工具参数：`editorKind`（可选，默认按工具固定）、`instanceId`、`commandId`/`exportId`。

`output.schema`（四态，所有工具共用）：

```js
const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status:      { type: 'string', required: true, enum: ['applied','rejected','pending','unknown'] },
    commandId:   { type: 'string', required: true },
    revision:    { type: 'integer' },
    stateDigest: { type: 'string' },
    canUndo:     { type: 'boolean' },
    canRedo:     { type: 'boolean' },
    approvalId:  { type: 'string' },
    auditRef:    { type: 'string' },
    error: { type: 'object', additionalProperties: false, properties: {
      code:      { type: 'string', required: true },
      message:   { type: 'string', required: true },
      retryable: { type: 'boolean' },
    }},
  },
}
```

`render`：一行中文摘要。`presentationMeta`：`{ operation, status, editorKind, beforeDigest, afterDigest, risk, approvalId, auditRef }` —— 2.x 界面只认这个。

---

## 6. 门控设计

三层，顺序固定：

1. **`ctx.tools.guard`（同步）**：拒绝未知 `operation`、`editorKind` 与工具不匹配、`autonomous` 缺 capability。只做静态判断，不 await。
2. **`execute` 内审批**：高风险集合 = 导入本地媒体、批量删除（`clip.remove` 批量 / `layer.remove` 批量）、覆盖导出、权限/共享变更。命中则
   `const decision = await ctx.approval.request({ agent: exec.agent, toolName, callId: args.commandId, reason, signal: exec.signal })`；`decision !== 'allowed-once'` → 返回 `status:'rejected'`，不写编辑器。
3. **编辑器校验**：`expectedRevision` + `commandId` 幂等 + 写完 `read_state` 回读 digest。

**capability 表**（插件自有，不依赖审批策略）：`autonomous` 仅允许 `media.video.clip.move`、`media.video.clip.trim`、`media.video.overlay.add`、`media.video.overlay.update`、`media.image.layer.update_text` 这类可撤销低风险写入；其余一律需人工。

**隔离 profile 的一个现实问题**：`diagram-test` 目前没有 approval answerer，`ctx.approval.request` 会返回 `unavailable` → 高风险工具在验证时会全部 `rejected`。这属于预期 fail-closed，验证时按「拒绝即正确」判定；若要验证放行路径，需要在该 profile 里挂一个测试 answerer（另开一步，不在本方案内）。

---

## 7. 超时与 unknown

- `media_*_read_state`、`media_*_get_command_result`、`media_video_export_status`：`timeoutMs` 可设（建议 10s）。
- `media_*_apply_command`、`media_video_export_start`：**不设 `timeoutMs`**。DSH 的超时只是 abort，编辑器侧写入可能已经落地；abort 后必须返回 `status:'unknown'` + 原 `commandId`，由用户/Agent 用 `get_command_result` 查询，禁止重放。
- relay 内部仍保留租约与 pending 上限；`unknown` 记录在插件内存 `uncertain` 表，进程重启后丢失 —— 这一点写进 README 的已知限制。

---

## 8. 路由与 token

- `ctx.effect(() => ctx.webServer.register({ kind:'prefix', path:'/media/image', handler }), 'media-studio: /media/image')`，视频同理。重复注册会抛错，所以每个 path 只注册一次。
- 页面：`/media/video/` → `public/video/index.html` + 相对资源；`/media/video/host/` → `public/video/host.html`（保留 wrapper 形态，便于同源 MessageChannel）。
- token：`apply` 里 `randomBytes(32).toString('hex')`，只经 `GET /media/boot` 下发（要求 `sec-fetch-site: same-origin` + `sec-fetch-dest: empty`），不进 URL、不写日志。
- **删除** `/prototype-tools`、`/video-tools`：插件里工具只能走 `ctx.tools`，HTTP 工具面必须消失，否则等于多开一个绕过审批的写入口。
- 静态根改为包内 `public/`，`realpath` + 相对路径判定保留，`..`/绝对路径/`.map`/测试目录一律 404。

---

## 9. 隔离 profile 装载与验证

> **实施结果（已更新）**：本方案已落地为 `plugin/dsh-media-studio/`，装进 `diagram-test` 并验证到「加载 + 注册」层。
> 关键实测差异：
> 1. peer 写死 `0.2.1-rc.2` **被 dsh 直接拒绝**（`installation rejected … incompatible with dsh 0.2.0-rc.2`），改为区间 `>=0.2.0-rc.2 <0.3.0` 后安装通过。
> 2. 插件自带的 `cordis.patch.yml` 会被 dsh 当作 bundle patch **自动插入**；在 profile patch 里再手工加一行会产生重复 id（已实测并移除）。
> 3. pnpm 对 `file:` 依赖是**复制**而非软链，改完包源码必须 remove + add 才生效。
> 4. `apply` 不再导出 `Config`（避免 `schemastery` peer），配置由 patch 行注入。
> 5. 路由注册合并为**一条** `prefix /media`，避免多条前缀互相覆盖。

### 装载

```powershell
# 1) 包目录（本方案产物）
$pkg = 'C:\Users\UEFR\.dsh\bot\workspace\diagram-studio-prototype\plugin\dsh-media-studio'
# 2) 装进隔离 profile（pnpm 走 file: 链接）
dsh plugin --profile diagram-test add "file:$pkg"
# 3) 在 diagram-test/cordis.patch.yml 追加 insert 行（§3.2）
# 4) 核对合成结果
dsh --profile diagram-test --dump-config | Select-String 'dsh-media-studio' -Context 2,4
```

回滚：`dsh plugin --profile diagram-test remove dsh-media-studio`，并删掉 patch 行。**不触碰 `desktop` / `web`。**

### 验证清单（逐条要有证据）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `--dump-config` | 出现 `- id: dsh-media-studio` |
| 2 | 启动日志 / 工具列表 | 6 个 `media_*` 工具可见 |
| 3 | `/media/video/` | 200，中文页，标注真实插件（不再写 local-harness） |
| 4 | `/media/boot` | 同源 200 带 token；跨源/无 sec-fetch 头 403 |
| 5 | relay register | `kind=video` 200，`kind=image` 400 |
| 6 | 跨 editorKind 调用 | 被 guard 拒绝 |
| 7 | 高风险无审批 | `status:'rejected'`，状态不变 |
| 8 | 低风险 assist + 已确认 | `status:'applied'`，revision/digest 变化，可回读 |
| 9 | 过期 `expectedRevision` | 冲突错误，不落库 |
| 10 | 重复 `commandId` | 返回原结果，不二次写入 |
| 11 | 超时 | `status:'unknown'` + 原 `commandId`，查询可恢复 |
| 12 | `/prototype-tools`、`/video-tools` | 404（已删除） |

---

## 10. 风险与 unknown

**风险**
1. **peer 版本两棵树不一致**（CLI 0.2.0-rc.2 / 桌面 0.2.1-rc.5）。已按 Chief 锁定写 `0.2.1-rc.2`，但安装走 CLI 侧 pnpm，真实行为需 `--dry-run` 预检；失败则放宽区间，不改生产。
2. `ctx.approval` 在 `diagram-test` 无 answerer → 高风险路径只能验证「被拒」。
3. 静态页体积：miniPaint 构建产物较大，放包内会撑大插件；可先只装视频页，图片页沿用现有 `/editor/`。

**unknown（不得宣称已验证）**
- 桌面 0.2.1-rc.5 与 0.2.0-rc.2 契约是否逐条一致（app.asar 不可读）。
- 点号工具名在 provider 端是否合法（已规避，用下划线）。
- `ctx.approval` 在真实 GUI turn 里的交互表现。
- client bundle / 侧栏内嵌（本轮不做）。
