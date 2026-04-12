# Phase 6：命令集 设计文档

- **创建日期**：2026-04-12
- **状态**：设计草案（待实施）
- **作者**：zhaodongsheng × Claude
- **上游依赖**：`docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` §8
- **下游产出**：`docs/superpowers/plans/2026-04-12-phase-6-command-set.md`

---

## 1. 目标

实现 §8 中不依赖持久化的命令集：`/new`、`/cd`、`/project`、`/mode`、`/model`、`/status`、`/help`、`/config show`。所有命令在飞书层拦截，不穿透到 Claude。

**成功标准**：
1. 8 条命令正确解析、分派、执行
2. `/new` 在任意状态下销毁旧会话，下条消息自动开新会话
3. `/cd` 发出确认卡片，点击后切换工作目录，下一轮使用新目录
4. `/mode` 和 `/model` 的运行时覆盖跨轮次持续直到 `/new`
5. `/mode acceptEdits` 等效于点击权限卡的"会话 acceptEdits"按钮（统一 sticky 标志）
6. `/status` 显示准确的实时会话状态
7. 未知 `/foo` 命令回复提示
8. 所有现有测试 + ~40 条新测试全绿

**非目标（Phase 7+）**：
- `/resume`、`/sessions`（需要持久化 session_id）
- `/config set`、`/config set --persist`（运行时配置修改 + TOML 写入）
- session_id 捕获
- StateStore 会话写入
- 崩溃恢复 / 恢复通知

---

## 2. 命令解析

### 2.1 扩展 `CommandRouterResult`

```ts
type ParsedCommand =
  | { name: "new" }
  | { name: "cd"; path: string }
  | { name: "project"; alias: string }
  | { name: "mode"; mode: PermissionMode }
  | { name: "model"; model: string }
  | { name: "status" }
  | { name: "help" }
  | { name: "config_show" };

type CommandRouterResult =
  | { kind: "run"; text: string }
  | { kind: "stop" }
  | { kind: "interrupt_and_run"; text: string }
  | { kind: "command"; cmd: ParsedCommand }
  | { kind: "unknown_command"; raw: string };
```

### 2.2 解析规则

- `/stop` — 保持现有行为（不进入新的 command kind）
- `!<payload>` — 保持现有行为
- `/new`（大小写不敏感，允许尾随空白）→ `{kind: "command", cmd: {name: "new"}}`
- `/cd <path>`（path 非空）→ `{kind: "command", cmd: {name: "cd", path: trimmed}}`
- `/cd`（无参数）→ `{kind: "unknown_command"}`
- `/project <alias>` → `{kind: "command", cmd: {name: "project", alias: trimmed}}`
- `/mode <m>`（m ∈ `default|acceptEdits|plan|bypassPermissions`）→ 对应 command
- `/mode badvalue` → `{kind: "unknown_command"}`
- `/model <m>`（m 非空）→ `{kind: "command", cmd: {name: "model", model: trimmed}}`
- `/status`、`/help` → 对应 command
- `/config show` → `{kind: "command", cmd: {name: "config_show"}}`
- `/config`（无 show）→ `{kind: "unknown_command"}`
- `/unknowncmd` → `{kind: "unknown_command"}` （仅当 word 不在已知集合中）
- `/etc/hosts` 等非已知命令前缀 → `{kind: "run"}` 穿透到 Claude

已知命令集合：`new, cd, project, mode, model, status, help, config, stop`。只有 `/` 后紧跟已知命令词（大小写不敏感）才视为命令；否则全文作为 `run` 发给 Claude。

---

## 3. CommandDispatcher

### 3.1 职责

新文件 `src/commands/dispatcher.ts`，一个类，每条命令一个方法。所有命令通过 `FeishuClient.replyText` 或 `replyCard` 直接回复用户，不经过 Claude session。

### 3.2 依赖注入

```ts
interface CommandDispatcherOptions {
  sessionManager: ClaudeSessionManager;
  feishu: FeishuClient;
  config: AppConfig;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  clock: Clock;
  logger: Logger;
}
```

### 3.3 CommandContext

每个命令方法接收一个上下文对象：

```ts
interface CommandContext {
  chatId: string;
  senderOpenId: string;
  parentMessageId: string;
}
```

### 3.4 命令语义

| 命令 | 状态要求 | 行为 |
|---|---|---|
| `/new` | 任意 | generating → 先调 `session.stop()`（interrupt + cancel brokers）。从 manager 删除会话。回复 "新会话已开始，下条消息将开启新对话"。 |
| `/cd <path>` | idle | 验证路径存在（`fs.stat`）。发 2 按钮确认卡（确认/取消，60s 超时）。确认 → 删旧会话 + 设 cwd override + 回复确认。取消/超时 → 回复取消。 |
| `/project <alias>` | idle | 在 `config.projects` 中查找别名 → 路径。找不到 → 错误回复含可用别名列表。找到 → 同 `/cd <resolved-path>`。 |
| `/mode <m>` | idle | 设会话 permissionMode override。`acceptEdits` → sticky=true；其他 → sticky=false。回复 "权限模式已切换为 \<m\>"。 |
| `/model <m>` | idle | 设会话 model override。回复 "模型已切换为 \<m\>"。 |
| `/status` | 任意 | 回复文本：state / cwd / permissionMode / model / 轮次数 / 队列长度。 |
| `/help` | 任意 | 回复文本：所有命令及一行描述，按类别分组。 |
| `/config show` | 任意 | 回复格式化文本：当前有效配置，`app_secret` 脱敏为 `***`，运行时 override 标注。 |

**状态检查**：需要 idle 的命令，检查 `session.getState() !== "idle"` 时回复 "会话正在执行中，请先发送 /stop 或等待完成"。

---

## 4. `/cd` 确认卡片

### 4.1 架构

不新建 broker。在 `CommandDispatcher` 内维护 `pendingCdConfirms: Map<requestId, PendingCdConfirm>`。

```ts
interface PendingCdConfirm {
  requestId: string;
  ownerOpenId: string;
  cardMessageId: string;
  targetPath: string;
  chatId: string;
  timer: TimeoutHandle; // 60s auto-cancel
}
```

### 4.2 卡片结构

文件：`src/feishu/cards/cd-confirm-card.ts`

**Pending 卡片**：
- `schema: "2.0"`，`config.update_multi: true`
- Header: `📁 切换工作目录`（blue template）
- Body markdown: `**目标路径:** \`/path/to/dir\``
- 两个按钮: `[确认]` value `{kind: "cd_confirm", request_id, accepted: true}`，`[取消]` value `{kind: "cd_confirm", request_id, accepted: false}`
- Footer: owner-only 提示

**Resolved 卡片**（compact）：
- 无 header。markdown: `📁 工作目录已切换为 \`/path/to/dir\``

**Cancelled 卡片**（compact）：
- 无 header。markdown: `🛑 已取消切换工作目录`

**Timed-out 卡片**（compact）：
- 无 header。markdown: `⏰ 切换工作目录已超时`

### 4.3 点击路由

`index.ts` 的 `onCardAction` 新增 `kind === "cd_confirm"` 分支：
- Owner 校验
- 调用 `dispatcher.resolveCdConfirm(requestId, senderOpenId, accepted)`
- 确认 → 返回 resolved 卡片（通过 callback response body 更新）
- 取消 → 返回 cancelled 卡片
- 超时 → 通过 `patchCard` 更新（out-of-band）

### 4.4 确认后的操作

1. 从 manager 删除旧会话（`manager.delete(chatId)`）
2. 在 manager 的 `cwdOverrides` map 上写入 `chatId → targetPath`
3. 下次 `getOrCreate(chatId)` 时新会话使用 override 路径

---

## 5. Session API 扩展

### 5.1 新公开方法

```ts
getState(): SessionState
  // 当前状态（idle / generating / awaiting_permission）
  // 重命名现有 _testGetState()

setPermissionModeOverride(mode: PermissionMode): void
  // 如果 mode === "acceptEdits" → sessionAcceptEditsSticky = true
  // 否则 → sessionAcceptEditsSticky = false
  // 存储 override 供后续轮次使用

setModelOverride(model: string): void
  // 存储 model override 供后续轮次使用

getStatus(): SessionStatus
  // 返回 { state, permissionMode, model, turnCount, queueLength }
```

### 5.2 Override 存储

Session 新增两个可选字段：
- `permissionModeOverride?: PermissionMode`
- `modelOverride?: string`

`processLoop` 中构建 `queryFn` 参数时优先读取 override：
```ts
const permissionMode = this.sessionAcceptEditsSticky
  ? "acceptEdits"
  : (this.permissionModeOverride ?? this.config.defaultPermissionMode);
const model = this.modelOverride ?? this.config.defaultModel;
```

注意：`sessionAcceptEditsSticky` 优先级最高，与 `setPermissionModeOverride` 统一后两者一致——调用 `setPermissionModeOverride("acceptEdits")` 同时设置 sticky=true。

### 5.3 SessionManager 扩展

```ts
delete(chatId: string): void
  // 从 sessions map 中删除

cwdOverrides: Map<string, string>
  // /cd 确认后写入

getOrCreate(chatId: string): ClaudeSession
  // 构建时 cwd = cwdOverrides.get(chatId) ?? config.defaultCwd
```

### 5.4 Turn 统计

Session 累加 `turnCount: number`（每次 `runTurn` 结束 +1），供 `/status` 使用。Token 统计需要从 `QueryResult` 中读取 `inputTokens` / `outputTokens` 累加到 `totalInputTokens` / `totalOutputTokens`。

---

## 6. 配置扩展

### 6.1 `[projects]` 表

`config.ts` 新增可选表：

```ts
const ProjectsSchema = z.record(z.string(), z.string()).default({});
```

在 `ConfigSchema` 中：
```ts
projects: ProjectsSchema.optional().default({}),
```

解析到 `AppConfig.projects: Record<string, string>`，值经过 `expandHome()` 展开。

### 6.2 `config.example.toml`

新增示例：
```toml
# [projects]
# my-app = "~/projects/my-app"
# infra = "~/projects/infrastructure"
```

---

## 7. 测试策略

### 7.1 Router 测试

扩展 `test/unit/commands/router.test.ts`，覆盖所有新命令的解析、边界情况、unknown_command 判定。纯函数，无需 mock。

### 7.2 Dispatcher 测试

新建 `test/unit/commands/dispatcher.test.ts`。使用 FakeFeishuClient、FakeSessionManager 等 fake。每条命令一个 describe block：
- `/new` idle → 会话被删，回复已发
- `/new` generating → stop 先被调用，然后删除
- `/cd` idle → 卡片发出，确认 click → 会话删除 + cwd override + 卡片更新
- `/cd` cancel click → 无变更，卡片更新
- `/cd` timeout → 自动取消
- `/cd` non-idle → 拒绝回复
- `/cd` 路径不存在 → 错误回复
- `/mode acceptEdits` → sticky=true，回复
- `/mode default` → sticky=false，回复
- `/mode` non-idle → 拒绝回复
- `/model xyz` → override 设置，回复
- `/status` → 回复含 state/cwd/mode
- `/help` → 回复含所有命令名
- `/config show` → 回复含配置，secret 脱敏
- `/project foo` → 路径查找 + 同 `/cd` 流程
- `/project unknown` → 错误回复含可用别名

### 7.3 卡片测试

`test/unit/feishu/cards/cd-confirm-card.test.ts`：pending 有按钮，resolved/cancelled/timed-out 无按钮，内容断言。

### 7.4 Session 测试

扩展 `test/unit/claude/session-state-machine.test.ts`：
- `setPermissionModeOverride` → processLoop 使用 override
- `setModelOverride` → processLoop 使用 override
- `getStatus` 返回正确值
- turnCount / token 累加

### 7.5 错误处理

- `/cd` 路径不存在 → `fs.stat` 失败 → 回复 "路径不存在: /bad/path"
- `/project` 未知别名 → 回复 "未知项目别名: foo，可用别名: bar, baz"
- `/mode` / `/model` 非 idle → 回复 "会话正在执行中，请先发送 /stop 或等待完成"
- 卡片 click 竞态（超时后 confirm）→ `not_found`（pending entry 已移除）
- 所有错误路径 reply-and-return，不抛异常

---

## 8. 文件清单

### 新建
| 文件 | 用途 |
|---|---|
| `src/commands/dispatcher.ts` | CommandDispatcher 类 |
| `src/feishu/cards/cd-confirm-card.ts` | /cd 确认卡片 builders |
| `test/unit/commands/dispatcher.test.ts` | Dispatcher 单元测试 |
| `test/unit/feishu/cards/cd-confirm-card.test.ts` | 卡片 builder 测试 |

### 修改
| 文件 | 变更 |
|---|---|
| `src/commands/router.ts` | 扩展 union + ParsedCommand + 命令解析逻辑 |
| `src/claude/session.ts` | 新增 getState/setPermissionModeOverride/setModelOverride/getStatus、override 字段、turnCount/token 累加 |
| `src/claude/session-manager.ts` | 新增 delete()、cwdOverrides map、getOrCreate 读 override |
| `src/config.ts` | 新增 projects 表 |
| `src/types.ts` | AppConfig 新增 projects 字段 |
| `src/index.ts` | 构建 CommandDispatcher、路由 command/unknown_command、cd_confirm 卡片 action |
| `config.example.toml` | 新增 [projects] 示例 |
| `test/unit/commands/router.test.ts` | 新命令解析测试 |
| `test/unit/claude/session-state-machine.test.ts` | override 访问器 + processLoop 测试 |
