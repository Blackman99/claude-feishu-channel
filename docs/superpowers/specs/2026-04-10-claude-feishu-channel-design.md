# claude-feishu-channel 设计文档

- **创建日期**：2026-04-10
- **状态**：设计草案（待实施）
- **作者**：zhaodongsheng × Claude
- **目标读者**：实施者（未来的 Claude Code 会话 / 作者自己）

---

## 1. 目标

把一个长期运行的 Claude Code 会话"挂接"到飞书 bot 上，让作者可以离开电脑后仍然通过手机飞书指挥本机 Claude Code 完成编码、调试、文件操作等任务。飞书 bot 是前端，本机 Claude Code 是执行者。

**成功标准**：在手机飞书里能完成"打开 Claude Code 问它一个问题 → 看到它调工具 → 批准危险操作 → 收到最终回复"的完整闭环，行为与在终端里使用 Claude Code 等价。

**非目标**：
- 不是一个通用聊天机器人
- 不是多租户 SaaS，单机单用户
- 不替代终端 Claude Code，只提供远程通道

---

## 2. 核心约束

| 约束 | 选择 | 原因 |
|---|---|---|
| Claude 形态 | Claude Code CLI | 需要访问本机文件系统和 shell，`Claude API`/纯 Agent SDK 无法满足 |
| 驱动方式 | `@anthropic-ai/claude-agent-sdk` TypeScript SDK | 原生支持流式输入、`canUseTool` 异步回调、`interrupt()`、`resume(session_id)` |
| 连接方式 | 飞书 WebSocket 长连接（`WSClient`） | 无需公网 IP / 端口映射，自动重连 |
| 运行环境 | 本机单进程 Node.js | 需要直接操作本机文件 |
| 会话绑定 | 一个飞书 chat（`chat_id`）= 一个常驻 `ClaudeSession` | 用户心智模型最直接 |
| 访问控制 | 白名单 `open_id` | bot 等同于本机 shell 权限，必须严格限制 |

---

## 3. 架构总览

```
┌─────────────┐                     ┌──────────────────────────────────┐
│  Feishu     │  WebSocket 长连接    │  claude-feishu-channel (Node.js) │
│  Open       │ ◄────────────────►  │                                  │
│  Platform   │                     │  ┌────────────────────────────┐  │
└─────────────┘                     │  │ FeishuGateway              │  │
                                    │  │ (WSClient + 事件分发)      │  │
                                    │  └──────┬─────────────────────┘  │
                                    │         │                        │
                                    │  ┌──────▼─────────────────────┐  │
                                    │  │ CommandRouter              │  │
                                    │  │ /命令  → handlers          │  │
                                    │  │ 普通消息/!前缀 → Session   │  │
                                    │  └──────┬─────────────────────┘  │
                                    │         │                        │
                                    │  ┌──────▼─────────────────────┐  │
                                    │  │ SessionManager             │  │
                                    │  │ chat_id → ClaudeSession    │  │
                                    │  └──────┬─────────────────────┘  │
                                    │         │                        │
                                    │  ┌──────▼─────────────────────┐  │
                                    │  │ ClaudeSession (常驻)       │  │
                                    │  │ - 状态机 + 输入队列        │  │
                                    │  │ - Agent SDK query()        │  │
                                    │  │ - canUseTool 回调          │  │
                                    │  └──────┬─────────────────────┘  │
                                    │         │ 依赖注入                │
                                    │  ┌──────▼─────────────────────┐  │
                                    │  │ Renderer + PermissionBroker│  │
                                    │  │ (独立模块，DI 进 Session)   │  │
                                    │  └──────┬─────────────────────┘  │
                                    │         │                        │
                                    │  ┌──────▼─────────────────────┐  │
                                    │  │ FeishuClient (REST + 上传) │  │
                                    │  └────────────────────────────┘  │
                                    │                                   │
                                    │  ┌────────────────────────────┐  │
                                    │  │ StateStore (原子 JSON)     │  │
                                    │  │ ~/.claude-feishu-channel/  │  │
                                    │  │   state.json               │  │
                                    │  └────────────────────────────┘  │
                                    │                                   │
                                    │  ┌────────────────────────────┐  │
                                    │  │ Config (TOML)              │  │
                                    │  └────────────────────────────┘  │
                                    └──────────────────────────────────┘
```

**职责边界**：
- `FeishuGateway` 只负责 WSClient 事件 → 内部 `IncomingMessage`/`CardAction` 的翻译
- `CommandRouter` 识别斜杠命令和 `!` 前缀，其余当作普通用户消息丢给 Session
- `SessionManager` 懒创建/查找 `ClaudeSession`，持有 `chat_id → session` 映射
- `ClaudeSession` 是状态/队列/query 生命周期的唯一真相源，`Renderer` 和 `PermissionBroker` 作为依赖注入进来（便于测试时替换）
- `Renderer` 无状态，纯翻译：SDK 事件 → 飞书消息/卡片 JSON
- `PermissionBroker` 管理 pending Deferred Promise 的字典 + 超时定时器
- `FeishuClient` 是所有 REST 调用的单点，发送按 chat_id 粒度串行化（每个 chat 一把 mutex）

---

## 4. ClaudeSession：核心状态机

**状态**：
```
idle   ──enqueue──►   generating   ──permission_req──►   awaiting_permission
  ▲                        │                                   │
  │                        ├──result_end──┐                    │
  │                        │              │                    │
  └────────────────────────┴──────────────┴────────────────────┘
                                (回到 idle)
```

**状态说明**：
- `idle`：无正在进行的轮次，等待新输入
- `generating`：当前轮正在进行（Claude 可能在产出文本、调用工具、等 tool result）
- `awaiting_permission`：Claude 请求了需要批准的工具调用，`canUseTool` 回调正在挂起等飞书卡片响应

**状态转换规则**：

| 当前状态 | 输入事件 | 动作 | 下一状态 |
|---|---|---|---|
| `idle` | 普通消息 | 向 query 投递该消息 | `generating` |
| `idle` | `!消息` | 去掉 `!` 前缀后同上 | `generating` |
| `idle` | `/stop` | 无操作 | `idle` |
| `generating` | 普通消息 | 追加到队列尾，回复"已加入队列 #n" | `generating` |
| `generating` | `!消息` | `await query.interrupt()` → 队列清空 → 投递该消息 | `generating` |
| `generating` | `/stop` | `await query.interrupt()` | `generating` → `idle`（等 interrupted result） |
| `generating` | SDK `SDKResultMessage` | 若队列非空，取队首投递；否则回 idle | `generating` 或 `idle` |
| `generating` | SDK `canUseTool` 回调触发 | 发权限卡片 + 启动超时定时器 | `awaiting_permission` |
| `awaiting_permission` | 普通消息 | 追加到队列尾，回复"已加入队列 #n" | `awaiting_permission` |
| `awaiting_permission` | `!消息` | resolve(deny) + `interrupt()` + 清空队列 + 投递该消息 | `generating` |
| `awaiting_permission` | `/stop` | resolve(deny, "用户取消") + `interrupt()` | `generating` → `idle` |
| `awaiting_permission` | 卡片按钮 [允许] | resolve(allow) | `generating` |
| `awaiting_permission` | 卡片按钮 [拒绝] | resolve(deny) | `generating` |
| `awaiting_permission` | 卡片按钮 [始终允许] | `setPermissionMode('acceptEdits')` 或加 PermissionUpdate → resolve(allow) | `generating` |
| `awaiting_permission` | 超时 5 分钟 | resolve(deny, "权限请求超时") | `generating` |
| `idle` | `/new` | 丢弃旧 session 引用，下条消息会创建新 session | `idle` |
| `generating` | `/new` | `interrupt()` → 丢弃旧 session → 下条消息会创建新 session | `idle`（等 interrupted result） |
| `awaiting_permission` | `/new` | resolve(deny) + `interrupt()` + 丢弃旧 session | `idle`（等 interrupted result） |
| `idle` | `/cd` 确认后 | 丢弃旧 session，创建新 session（cwd=目标） | `idle` |
| `generating`/`awaiting_permission` | `/cd` | 回提示"请先 /stop" | 不变 |
| 任意 | SDK 异常 / `SDKResultMessage` subtype=error | 渲染错误卡片；session 回 `idle`，队列保留 | `idle` |

**输入队列**：
- 普通 FIFO 队列
- 每个飞书消息 `{text, messageId, timestamp}`
- 队列操作必须加锁（和状态转换同一把锁）

**不变式**：
- 任意时刻，一个 ClaudeSession 只有一个 turn 在 SDK 里进行
- `awaiting_permission` 状态下必有且仅有一个 pending permission Promise
- 队列里的消息永远按 FIFO 顺序被消费，除非 `!` 前缀或 `/stop` 介入

---

## 5. 并发模型：方案 D（严格排队 + `!` 前缀打断）

**核心规则**：
1. 默认：新消息追加到队列尾，按 FIFO 消费，绝不无故丢消息
2. `!` 前缀：显式打断信号，立即 `interrupt()` 并清空队列，然后投递该消息
3. `/stop`：只打断不投递，清空队列后回 idle

**为什么不选自动打断（方案 B）**：用户只是想补充一句"记得加注释"时，不应该把 Claude 正在写的代码打断；而且被打断的工具调用可能留下半成品文件。

**为什么要 `!` 前缀**：给用户一个显式的"我知道我在打断"的通道，比 `/stop` + 重发两步快，又比隐式打断安全。

---

## 6. 权限桥接（canUseTool ↔ 飞书卡片）

**流程**：
1. SDK 触发 `canUseTool(toolName, input, {signal, suggestions})`
2. ClaudeSession 进入 `awaiting_permission`，请 `PermissionBroker` 创建 `Deferred<PermissionResponse>` 并注册到 `deferredId → Deferred` 字典，同时启动两个定时器
3. ClaudeSession 请 `Renderer` 构造权限卡片（详见 §7.5）并通过 `FeishuClient` 发送，卡片 metadata 里带 `deferredId`
4. 超时定时器：`config.permission_timeout_seconds`（默认 300s）到期自动 resolve(deny)
5. 提醒定时器：`config.permission_timeout_seconds - permission_warn_before_seconds` 后发提醒
6. 用户点按钮 → `FeishuGateway.handleCardAction` → `CommandRouter` 分发到 `PermissionBroker.resolve(deferredId, response)` → 取消两个定时器
7. `canUseTool` 回调返回 SDK，Session 回到 `generating`

**权限响应**：
```ts
type PermissionResponse =
  | { behavior: "allow", updatedInput?: any }
  | { behavior: "deny", message: string };
```

**"始终允许"按钮的实现**：MVP 先用 `setPermissionMode('acceptEdits')`（粗粒度），第二阶段再考虑细粒度 `PermissionUpdate`。详见 §18 开放问题 1。

**超时后 Claude 的观感**：tool result 写入 "Permission request timed out after 5 minutes. Tool call was not executed."，Claude 会看到这条 result 然后决定重试 / 换方向 / 告知用户。

---

## 7. 飞书渲染策略

**通用原则**：
- 每个飞书 chat 一把 **send mutex**：同一个 chat 的所有发送必须串行化，保证显示顺序 = SDK 事件顺序
- 每条消息带 header 前缀标记来源：`🤖` Claude 文本、`🔧` 工具调用、`✅/❌` 结果、`⚠️` 权限请求、`💭` thinking

**渲染类型**：

### 7.1 普通文本（TextBlock）
- 飞书富文本 post 消息
- Markdown → 飞书富文本节点（代码块、行内代码、列表、链接）
- 超长文本（> `inline_max_bytes`）截断 + "查看完整内容" 按钮 → 点击后上传 `.md` 文件

### 7.2 Extended thinking 块
- 独立卡片，header "💭 思考过程"，默认折叠展示
- 配置项 `render.hide_thinking = true` → 完全不发送
- 只对支持 thinking 的模型有效

### 7.3 工具调用（ToolUseBlock + tool_result）
交互卡片：
- 标题：`🔧 <ToolName>`
- 参数摘要（按工具名走专用格式化器）：
  - `Read` → `path/to/file.ts:42-80`
  - `Edit` → `path/to/file.ts` + `+5/-2`
  - `Bash` → `$ npm test`（截断 80 字符）
  - `Grep` → `"pattern" in *.ts`
  - `Write` → `path/to/file.ts` (N bytes)
  - 默认 → JSON 单行摘要
- 结果预览：前 10 行 / `inline_max_bytes`，超长折叠，"展开全部" 按钮
- 失败：红色 header + 错误信息

### 7.4 特殊工具

| 工具名 | 渲染 |
|---|---|
| `TodoWrite` | 飞书复选框列表卡片。`render.todo_history_mode = "history"`（默认）时每次新卡；`"inplace"` 时 Session 保存 `current_todo_card_message_id`，首次创建后续 `patch_message` 原地编辑同一张。`/new` 时清空该 id |
| `ExitPlanMode` | "📋 执行计划" 卡片，plan 内容 markdown 渲染，底部按钮 `[批准执行]` `[继续讨论]` |
| `Task`（subagent） | 折叠组卡片，header = subagent 类型 + 任务描述，展开显示 subagent 的工具调用流（只展开一层，避免无限嵌套） |
| `AskUserQuestion` | 多选卡片，选项渲染成按钮，点击后作为用户消息回喂 Session |

### 7.5 权限请求卡片
- 黄色 header `⚠️ 需要批准`
- Body：工具名 + 参数详情（**完整展示，不截断**，让用户看清楚要做什么）
- 按钮：`[允许]` `[拒绝]` `[始终允许（本会话）]`
- 底部灰色倒计时 `⏰ 5:00`（前端渲染即可，服务端超时是权威源）

### 7.6 长 tool_result 统一策略

| 大小 | 处理 |
|---|---|
| ≤ `inline_max_bytes`（默认 2KB） | 内联 |
| `inline_max_bytes` ~ `file_upload_threshold_bytes`（默认 20KB） | 前 10 行 + "展开全部" 按钮 |
| > `file_upload_threshold_bytes` | 前 5 行 + 上传完整内容为附件 |
| Binary / 非 UTF-8 | 直接上传附件，不尝试展示 |

### 7.7 状态/系统消息

| SDK 事件 | 飞书处理 |
|---|---|
| `SDKSystemMessage` init | 不发飞书，本地日志 |
| `SDKResultMessage` success | 小 tip "✅ 本轮耗时 12.3s · 输入 1.2k / 输出 3.4k tokens"。`render.show_turn_stats = false` 时不发 |
| `SDKResultMessage` error | 红卡片显示错误类型 + 原始错误 |

---

## 8. 命令集

所有命令在飞书层拦截，不穿透到 Claude。

### 8.1 会话管理

| 命令 | 状态要求 | 作用 |
|---|---|---|
| `/new` | 任意（generating 下先 interrupt） | 结束当前 session，下条消息开新 session |
| `/cd <abs-path>` | `idle` | 发确认卡片 → 确认后新开 session，cwd = 指定路径 |
| `/project <name>` | `idle` | 同上，从配置 `[[projects]]` 查别名 → 路径 |
| `/resume <chat_id>` | `idle` | 当前飞书 chat 绑定到另一个飞书 chat 历史的 session_id |
| `/sessions` | 任意 | 列出所有历史 session（跨 chat），可 `/resume` 回任一 |

### 8.2 执行控制

| 命令 | 状态要求 | 作用 |
|---|---|---|
| `/stop` | 任意 | 见 §4 状态转换表 |
| `!<消息>` | 任意 | 打断前缀，见 §5 |

### 8.3 模式切换

| 命令 | 状态要求 | 作用 |
|---|---|---|
| `/mode default\|acceptEdits\|plan\|bypass` | `idle` | `query.setPermissionMode()` |
| `/model opus\|sonnet\|haiku` | `idle` | `query.setModel()` |

### 8.4 查询

| 命令 | 状态要求 | 作用 |
|---|---|---|
| `/status` | 任意 | 显示 state / cwd / permission mode / model / session_id / 历史轮数 / 累计 token / 队列长度 |
| `/help` | 任意 | 列出所有命令 |

### 8.5 配置

| 命令 | 状态要求 | 作用 |
|---|---|---|
| `/config show` | 任意 | 显示当前 session 有效配置 |
| `/config set <key> <value>` | 任意 | 运行时改配置，只对当前 session |
| `/config set <key> <value> --persist` | 任意 | 同上并写回 `config.toml` |

### 8.6 特殊命令语义细节

- **`/new` 在 `generating`**：直接 interrupt + 丢弃旧 session + 创建新（不发确认卡）
- **`/cd` 确认卡片**：按钮 `[确认]` `[取消]`，超时 60s 自动取消
- **`/stop` 在 `idle`**：不报错，静默忽略
- **未知命令**：回 "未知命令，发 `/help` 查看可用命令"

---

## 9. 配置文件

**位置**：`~/.claude-feishu-channel/config.toml`（可被 `CLAUDE_FEISHU_CONFIG` 环境变量覆盖）

**首次启动**：若不存在则生成带注释的模板（见 `config.example.toml`），打印 "请填写配置后重启" 并以非 0 码退出。

**Schema**：

```toml
# ─── Feishu 应用凭据 ─────────────────────────
[feishu]
app_id = "cli_xxx"
app_secret = "yyy"
encrypt_key = ""              # 可选
verification_token = ""       # 可选

# ─── 访问控制 ───────────────────────────────
[access]
allowed_open_ids = ["ou_xxx"]
unauthorized_behavior = "ignore"   # "ignore" | "reject"

# ─── Claude 运行参数 ─────────────────────────
[claude]
default_cwd = "/Users/zhaodongsheng/my-projects"
default_permission_mode = "default"   # default | acceptEdits | plan | bypassPermissions
default_model = "claude-opus-4-6"
permission_timeout_seconds = 300
permission_warn_before_seconds = 60

# ─── 预定义项目（/project <name>） ───────────
[[projects]]
name = "channel"
cwd = "/Users/zhaodongsheng/my-projects/claude-feishu-channel"

# ─── 渲染行为 ───────────────────────────────
[render]
hide_thinking = false          # false=折叠显示, true=完全不发
show_turn_stats = true
todo_history_mode = "history"  # "history" | "inplace"
inline_max_bytes = 2048
file_upload_threshold_bytes = 20480

# ─── 持久化 ─────────────────────────────────
[persistence]
state_file = "~/.claude-feishu-channel/state.json"
log_dir = "~/.claude-feishu-channel/logs"
session_ttl_days = 30
```

**校验**：启动时用 `zod` 做 schema 校验，任何必填缺失或类型错误 fail-fast 并打印具体字段路径。

---

## 10. 持久化

**文件**：`~/.claude-feishu-channel/state.json`

**Schema**：
```json
{
  "version": 1,
  "last_clean_shutdown": true,
  "sessions": {
    "<feishu_chat_id>": {
      "claude_session_id": "abc-123",
      "cwd": "/Users/zhaodongsheng/my-projects/foo",
      "permission_mode": "default",
      "model": "claude-opus-4-6",
      "created_at": "2026-04-10T10:30:00Z",
      "last_active_at": "2026-04-10T11:42:00Z"
    }
  }
}
```

**写入时机**（两种场景）：

**场景 A：结构变更（必须立即写）**
- `query()` 启动拿到新 `session_id` 时：新增 session 条目，**同步等待**原子写入完成后才开始消费输入
- Session 被 `/new`/`/cd` 丢弃时：删除条目并立即写
- `permission_mode`/`model` 变更时：更新字段并立即写

**场景 B：活跃度更新（可防抖）**
- `last_active_at` 每次 session 收到消息或完成一轮时更新
- 防抖 30s 批量写一次，避免频繁磁盘 IO
- 进程退出前 flush 未写入的防抖缓冲

**启动/退出标记**
- 启动时读取后立即写回 `last_clean_shutdown: false`（运行期间视为"不干净"）
- 正常退出时写入 `last_clean_shutdown: true`

**读取时机**：进程启动时全量加载

**崩溃恢复**：
- 启动时检查 `last_clean_shutdown`，若为 `false` → 有"未干净退出"发生
- 每个 session 在下次收到消息时，用 `query({ resume: session_id, cwd })` 恢复
- 恢复成功的 session，在首次响应前补发一条通知消息："⚠️ 上次 bot 异常重启，已恢复会话。请检查上一轮的执行结果是否完整"（只通知一次，通知后清除标记）

**清理**：启动时清理 `last_active_at < now - session_ttl_days` 的 session 记录（不删除 `~/.claude/projects/` 下的原始 session 文件，只清自己的映射）

**孤儿权限卡片**：进程重启后旧卡片按钮点击 → 找不到对应 Deferred → bot 回一条临时消息 "该请求已过期，请重新操作"，不尝试恢复。

---

## 11. 启动流程

```
1. 加载配置（含 env var 覆盖）
2. zod schema 校验 → 任何错误 fail-fast，打印具体字段
3. 检查 `claude` CLI 可用（`which claude` 或 child_process 试探）
4. 检查 ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN 至少一个存在
5. 创建 ~/.claude-feishu-channel/ 目录及子目录（若不存在）
6. 读取 state.json，记录 `last_clean_shutdown` 值，然后立即写回 false
7. 清理过期 session 记录
8. 初始化 pino logger（按配置）
9. 初始化 FeishuClient (REST) 和 FeishuGateway (WSClient)
10. 注册 message / card_action handler
11. 启动 WSClient
12. 打印 banner：白名单用户、默认 cwd、已加载 projects 数量、session 数量
13. 注册 SIGINT/SIGTERM handler → 写入 last_clean_shutdown=true 后退出
```

**fail-fast 原则**：任何初始化阶段的错误都不 catch，让进程崩出并打印原因。

---

## 12. 目录结构

```
claude-feishu-channel/
├── src/
│   ├── index.ts                    # 入口：启动流程
│   ├── config.ts                   # 配置加载 + zod 校验
│   ├── types.ts                    # 跨模块共享类型
│   │
│   ├── feishu/
│   │   ├── gateway.ts              # WSClient 封装 + 事件分发
│   │   ├── client.ts               # REST 客户端封装（send / patch / upload）
│   │   ├── cards.ts                # 卡片 JSON 构造函数
│   │   └── renderer.ts             # SDK 事件 → 飞书消息/卡片
│   │
│   ├── claude/
│   │   ├── session.ts              # ClaudeSession：状态机 + 输入队列
│   │   ├── session-manager.ts      # chat_id → ClaudeSession
│   │   └── permission-broker.ts    # canUseTool ↔ 卡片按钮 Promise
│   │
│   ├── commands/
│   │   ├── router.ts               # 命令识别 + 分发
│   │   └── handlers/
│   │       ├── new.ts
│   │       ├── cd.ts
│   │       ├── project.ts
│   │       ├── stop.ts
│   │       ├── mode.ts
│   │       ├── model.ts
│   │       ├── status.ts
│   │       ├── help.ts
│   │       ├── sessions.ts
│   │       ├── resume.ts
│   │       └── config.ts
│   │
│   ├── persistence/
│   │   └── state-store.ts          # state.json 原子读写
│   │
│   └── util/
│       ├── logger.ts               # pino 初始化
│       ├── mutex.ts                # 简易互斥锁
│       ├── dedup.ts                # LRU 消息去重
│       ├── deferred.ts             # Deferred Promise 辅助
│       └── clock.ts                # 可注入时钟（测试用）
│
├── test/
│   ├── unit/                       # 纯函数测试
│   └── integration/                # Session 状态机 / Gateway 集成测试
│
├── config.example.toml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
└── README.md
```

---

## 13. 依赖

**生产依赖**：
- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK
- `@larksuiteoapi/node-sdk` — 飞书官方 Node SDK（WSClient + REST）
- `smol-toml` — TOML 配置解析（比 `@iarna/toml` 轻）
- `zod` — 配置 schema 校验
- `pino` — 结构化日志
- `pino-pretty` — 开发环境美化输出

**开发依赖**：
- `typescript`
- `@types/node`
- `vitest` — 测试框架
- `tsx` — 开发时运行

**包管理器**：`pnpm`

---

## 14. 错误处理

### 14.1 错误分层

| 层 | 典型错误 | 处理 |
|---|---|---|
| 启动期 | 配置缺失、CLI 未装、key 缺失 | fail-fast，非 0 退出码 |
| Feishu 网络 | WS 断连 / REST 429 / 卡片发送失败 | WS 自动重连（SDK 内置）；REST 指数退避重试（最多 3 次）；最终失败写日志并丢弃，不阻塞 session |
| Claude SDK | `query()` throw / `SDKResultMessage` subtype=error | 捕获后渲染红卡片发到飞书；session 回到 `idle`，队列保留；**不**自动重试 |
| 权限超时 | 5 分钟无响应 | 自动 deny，tool result 写入超时原因 |
| 命令层 | 格式错误 / 状态不满足 | bot 回纠错消息，无副作用 |
| 未捕获异常 | 代码 bug | 全局 handler 写 crash 日志 → 通知第一个白名单用户 → 退出让 supervisor 拉起 |

### 14.2 幂等与去重

- 飞书 WS 重连可能重投事件，按 `message_id` 去重（LRU 1000 条）
- 卡片回调按 `(card_id, action_id)` 去重

### 14.3 崩溃恢复副作用

Session 崩溃时进行中的 tool 调用可能已经产生副作用（文件写了一半、命令执行了一半）。恢复后 Claude 看到的历史会包含没有 tool_result 的 tool_use，它会自行决定重试还是换方向。用户在恢复通知里被提醒"请检查上一轮的执行结果是否完整"，由用户验证。

---

## 15. 日志

- 框架：`pino`
- 开发：`pino-pretty` 美化
- 生产：纯 JSON 到文件
- 等级：`LOG_LEVEL` 环境变量，默认 `info`
- 结构化字段：`chat_id`, `session_id`, `event_type`, `tool_name`, `turn_id`
- 轮转：按天切割，保留 14 天（`pino-roll` 或外部 logrotate）
- **脱敏**：`app_secret` / `encrypt_key` / `ANTHROPIC_API_KEY` 等敏感字段在日志里一律打印 `***`，通过 `redact` 选项配置

---

## 16. 测试策略：选择性严格 TDD

### 16.1 原则

- **纯函数层 + 状态机层**：严格 Red-Green-Refactor，每次一个测试一次提交
- **集成适配层**：测试先行但粒度可粗，不必每个 Green 都 commit
- **端到端**：checklist 手测，不写自动化

### 16.2 纯函数层（严格 TDD）

覆盖对象：
- `config.ts` 的 zod schema 校验
- `commands/router.ts` 的命令解析
- `feishu/cards.ts` 的卡片 JSON 构造（对每类卡片）
- `feishu/renderer.ts` 的 SDK 事件 → 消息/卡片映射（对每种事件类型）
- `util/mutex.ts`
- `util/dedup.ts`
- `util/deferred.ts`
- `persistence/state-store.ts` 的序列化/反序列化

### 16.3 状态机层（严格 TDD，最关键）

`ClaudeSession` 采用依赖注入便于测试：

```ts
class ClaudeSession {
  constructor(deps: {
    createQuery: (opts: QueryOptions) => Query,  // 可注入 FakeQuery
    renderer: Renderer,                          // 可注入 SpyRenderer
    clock: Clock,                                // 可注入 FakeClock
    permissionTimeoutMs: number,
    warnBeforeMs: number,
  }) {}
}
```

**测试替身**：
- `FakeQuery`：预录脚本化 SDK 事件流（`emit(event)`），暴露 `pendingInputs`, `interrupted`, `lastPermissionResponse` 等观察点
- `FakeClock`：手动 `advance(ms)`，触发定时器回调
- `SpyRenderer`：记录所有 `render(event)` 调用

**关键测试用例**（30-50 个）：

会话生命周期：
- 首次 enqueue 从 idle → generating
- SDKResultMessage 到达后回 idle
- SDKResultMessage 到达时队列非空，自动取队首

排队行为（方案 D）：
- generating 状态下普通消息入队，不立即投递
- 入队时 bot 回"已加入队列 #n"
- 队列按 FIFO 消费

打断前缀：
- generating 状态下 `!消息` → interrupt + 清空队列 + 投递
- awaiting_permission 下 `!消息` → deny + interrupt + 投递

/stop：
- idle 下 /stop 无操作
- generating 下 /stop → interrupt → 清队列 → idle
- awaiting_permission 下 /stop → deny + interrupt → idle
- 连续两次 /stop 幂等

权限超时：
- FakeClock 推进 5 分钟 → 自动 deny，tool result 含超时说明
- 推进 4 分钟 → 发提醒卡片
- 超时前用户点允许 → 超时定时器取消
- "始终允许" 按钮 → setPermissionMode 被调用

崩溃恢复：
- resume 时传入正确的 session_id 和 cwd
- 恢复后首次响应前发通知消息

### 16.4 集成适配层（测试先行但粗粒度）

覆盖对象：
- `FeishuGateway` 的事件翻译（mock WSClient）
- `FeishuClient` 的 REST 调用（mock fetch / sdk client）
- `SessionManager` 的懒创建 + 映射

不测 SDK 自身的行为（重连、签名等），那是 SDK 的职责。

### 16.5 端到端手测 checklist

`docs/e2e-checklist.md` 维护如下清单，每次发 release 前手动跑一遍：

- [ ] 首次发消息 → 自动建 session → Claude 正常回复
- [ ] Claude 调用 Read/Edit/Bash → 卡片正确渲染
- [ ] Bash 触发权限卡片 → 点"允许"→ 正确执行
- [ ] 权限卡片不点 → 5 分钟后自动 deny，Claude 被告知超时
- [ ] 权限卡片不点 → 4 分钟时收到提醒
- [ ] 点"始终允许" → 后续同类调用不再弹卡
- [ ] TodoWrite history 模式 → 每次更新新卡
- [ ] TodoWrite inplace 模式 → 原地编辑
- [ ] ExitPlanMode → 计划卡片 + 批准按钮
- [ ] 长 `ls -R /` → 走文件上传
- [ ] generating 中发普通消息 → 入队回 "#1"
- [ ] generating 中发 `!` 消息 → 立即打断切换
- [ ] /stop 在 generating → interrupt
- [ ] /stop 在 awaiting_permission → deny + interrupt
- [ ] /cd 发确认卡 → 确认后新开
- [ ] /project 别名切换
- [ ] /new 在 generating → 直接新开
- [ ] /mode 切换权限模式
- [ ] /model 切换模型
- [ ] /status 显示正确
- [ ] /config set ... --persist → 写回 config.toml
- [ ] kill -9 → 重启 → 下条消息触发 resume → 回复包含恢复通知
- [ ] 非白名单用户发消息 → 完全无响应
- [ ] WS 断连重连 → 期间消息不丢（SDK 保证）且不重复消费（我方去重）

---

## 17. 显式声明的 YAGNI

以下功能 **不做**，如果未来要做需要单独提案：

- 跨机器 / 多实例部署
- 用户维度的权限颗粒度（当前只有全局白名单，没有"用户 A 只能用 X 项目"）
- 消息搜索 / 会话回放 UI（直接看 `~/.claude/projects/*.jsonl`）
- bot 多语言 i18n
- 指标导出（Prometheus / OTel）
- 图片输入 / 文件输入 / 多模态
- `/fork` session 分叉
- 富 Markdown → 飞书的完整转换（只做常见元素，exotic 的按原样）
- Hot-reload 配置文件（改配置需要重启）

---

## 18. 开放问题（实施阶段再决定）

1. **"始终允许" 的粒度**：是调 `setPermissionMode('acceptEdits')` 简单粗暴，还是构造具体的 `PermissionUpdate` 把某个工具的某种参数加白名单？精细做法更安全但复杂度高，可以 MVP 阶段先粗暴做，第二阶段再优化。

2. **飞书富文本转换**：Markdown → 飞书 post 节点的转换有多少 corner case？MVP 先支持：标题、列表、代码块、行内代码、链接、加粗/斜体。表格、图片、引用暂不支持或按原样。

3. **`resume` 的 cwd 验证**：SDK 要求 resume 时 cwd 与原 session 完全一致。若配置/项目表改动后 cwd 不匹配，要给出明确错误。

4. **日志文件轮转**：用 `pino-roll` 还是依赖 `launchd` + `newsyslog`？MVP 先用 `pino-roll`（代码层自包含）。

---

## 19. 实施阶段化建议

建议按以下顺序分阶段实施，每个阶段都可独立验证：

**Phase 1：骨架**
- 项目脚手架、config 加载、日志、state store
- FeishuGateway + 单条 echo 消息的闭环
- 目的：跑通"收到飞书消息 → 回一条消息" 最小链路

**Phase 2：单轮 Claude**
- ClaudeSession 最简实现（只支持一轮，无队列无状态机）
- Renderer 支持文本
- 目的：跑通"飞书消息 → Claude 单轮回复 → 飞书"

**Phase 3：工具调用渲染**
- Renderer 支持所有工具类型的卡片
- 长输出处理
- 目的：Claude 调工具能在飞书看到

**Phase 4：状态机 + 队列 + `!` 前缀**
- 完整状态机（严格 TDD）
- 输入队列
- `/stop` / `!` 前缀
- 目的：多轮对话和并发消息正确处理

**Phase 5：权限桥**
- canUseTool 接入
- 权限卡片 + 按钮回调
- 超时 + 提醒
- "始终允许" 按钮
- 目的：危险工具正确弹确认

**Phase 6：命令集**
- /new /cd /project /resume /mode /model /status /help /sessions /config
- /cd 确认卡片
- 目的：功能完整

**Phase 7：持久化 + 崩溃恢复**
- state.json 原子写入
- `last_clean_shutdown` 标记
- resume 流程 + 恢复通知
- 目的：进程可以被杀被重启

**Phase 8：E2E 手测 + 打磨**
- 按 §16.5 checklist 跑一遍
- 修掉所有问题
- README / config.example.toml 完善

每个阶段结束都能在飞书里看到一个可用的功能增量，不会有"写了三周还没法启动"的情况。
