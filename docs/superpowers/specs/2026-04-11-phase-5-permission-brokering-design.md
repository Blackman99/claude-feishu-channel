# Phase 5：权限桥接 设计文档

- **创建日期**：2026-04-11
- **状态**：设计草案（待实施）
- **作者**：zhaodongsheng × Claude
- **目标读者**：实施者（未来的 Claude Code 会话 / 作者自己）
- **上游依赖**：`docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` §5-6, §18
- **下游产出**：`docs/superpowers/plans/2026-04-11-phase-5-permission-brokering.md`

---

## 1. 目标

把 Phase 4 的 `NullPermissionBroker` 换成真家伙：当 Claude 在一轮对话中要调用工具（Edit/Bash/Write 等）时，把权限请求转发到 Feishu 群，用户点击"允许 / 拒绝 / 本轮 acceptEdits / 会话 acceptEdits"按钮，再把决策回灌给 SDK，让 Claude 的工具调用按用户意图继续或中止。

**成功标准**：
1. Claude 在 permission_mode=default 下发起的每次 side-effect 工具调用都触发一张权限卡片
2. 只有触发该轮的用户能点按钮；他人点击被 broker 拒绝（owner 校验）
3. 用户点"允许" → Claude 的工具调用被执行，回答 stream 继续
4. 用户点"拒绝" → Claude 的工具调用被拒，Claude 收到 deny 的 tool_result 继续推理
5. 用户点"本轮 acceptEdits" → 本次允许 + 本轮后续 Edit/Write 类工具自动过（通过 SDK 的 `setPermissionMode("acceptEdits")`）
6. 用户点"会话 acceptEdits" → 本轮打开闸门，后续所有轮次默认 acceptEdits（通过 session 级 sticky 标志）
7. 5 分钟无响应 → 自动 deny，tool_result 写入超时说明，Claude 看到后决定下一步
8. 4 分钟（= 超时前 60s）发纯文本提醒 "权限请求将在 60s 后自动拒绝"
9. `/stop` / `!前缀` 打断时，所有 pending 权限请求一把 deny
10. 端到端：从 `bypassPermissions` 默认切到 `default`，bot 的行为等同本地 claude 的交互式批准流

**非目标**（留给后续 Phase）：
- 细粒度的 `PermissionUpdate`（MVP 用 `acceptEdits` 整档切换）
- `/mode` 显式切换命令（Phase 6）
- `/new` 重置 sticky 标志（Phase 6）
- 多用户并发的 broker 实例管理（当前假设 bot 只服务一个 `allowed_open_id`）
- 卡片按钮 toast 反馈（是否做取决于 lark-sdk 的 action response 支持度，plan 阶段确认）

---

## 2. 核心架构决策

### 2.1 用 `@anthropic-ai/claude-agent-sdk` 替换 CLI 子进程

当前 `src/claude/cli-query.ts` 直接 `spawn claude --print --output-format stream-json`，自己解析每行 JSON。这条路不支持 `canUseTool` —— CLI 的 stream-json 协议没有把权限请求暴露出来。

**选择**：引入 `@anthropic-ai/claude-agent-sdk` 作为 transport 层。

**关键事实**：`@anthropic-ai/claude-agent-sdk` **仍然通过 spawn `claude` 二进制来驱动**（它的 `pathToClaudeCodeExecutable` 选项就是用来指定二进制路径的），但 SDK 帮我们管好了 stream-json 的权限请求/响应协议，并把它暴露成 TypeScript 的 `canUseTool: async (toolName, input, opts) => ...` 回调。

**这意味着**：
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 继续通过环境变量注入（SDK 的 `env` 选项 / 默认继承 `process.env`）
- 本机 `claude` 登录态、账户配置继续使用
- Phase 1 的 preflight（验证 `claude --version`）继续有效
- Phase 2-4 的 `QueryFn` / `QueryHandle` 抽象**保留**，只替换 `cli-query.ts` → `sdk-query.ts` 这一个实现文件
- CLI 子进程的 SIGTERM 中断改成 SDK 的 `AbortController.abort()`

### 2.2 `QueryFn` / `QueryHandle` 接口扩展

新增 `CanUseToolFn` 类型，把权限回调作为 QueryFn 的**参数**（不是 QueryHandle 的方法）——session 在 `runTurn` 里构造好 closure 再传入，这样 FakeQueryHandle 可以保存引用主动触发，用于测试 canUseTool 分支。

`QueryHandle` 新增 `setPermissionMode(mode)` 方法，对应 SDK 的 `query.setPermissionMode()`，用于"本轮 acceptEdits"按钮触发后改当前轮的权限模式。

### 2.3 `PermissionBroker` 职责收归

Phase 4 里 session 持有 `pendingPermission: Deferred<PermissionResponse>` 字段 + `_testEnterAwaitingPermission` 测试 seam，是为了给 Phase 5 留出测试点。Phase 5 把 pending 的生命周期**完全收归 broker**：

- session 只调 `broker.request(...)` 等待返回
- session 的 `/stop` / `!前缀` 路径调 `broker.cancelAll(reason)`，broker 内部一次性 resolve 所有 pending
- session 的 `pendingPermission` 字段和测试 seam **删除**，测试改用 `FakePermissionBroker` 注入

### 2.4 默认 `permission_mode` 切换

当前 `config.toml` 里是 `default_permission_mode = "bypassPermissions"`，这个值**完全绕过** `canUseTool`，Phase 5 必须切到 `"default"` 才能让 broker 被触发。config 示例文件更新，用户自己的 config 需手动改（上线通知里说明）。

### 2.5 四按钮方案

| 按钮 | choice 值 | 返回给 SDK | 副作用 |
|---|---|---|---|
| ✅ 允许 | `allow` | `{behavior: "allow"}` | 无 |
| ❌ 拒绝 | `deny` | `{behavior: "deny", message: "User denied the tool call."}` | 无 |
| ✅ 本轮 acceptEdits | `allow_turn` | `{behavior: "allow"}` | `currentTurn.handle.setPermissionMode("acceptEdits")` |
| ✅ 会话 acceptEdits | `allow_session` | `{behavior: "allow"}` | 同上 + `session.sessionAcceptEditsSticky = true` |

**关于"acceptEdits"的真实语义**：`acceptEdits` 模式只自动允许 `Edit`/`Write`/`MultiEdit`/`NotebookEdit` 等文件编辑类工具，`Bash`/`WebFetch`/`MCP` 等 side-effect 工具**仍然**会触发 `canUseTool`。按钮文案里显式带 "acceptEdits" 三个字就是为了让用户准确理解闸门的范围。

**sticky 标志清除**：Phase 5 没有清除路径；Phase 6 的 `/new` 和 `/mode default` 命令会清空。进程重启后 sticky 也丢失（内存字段）。

---

## 3. 接口定义

### 3.1 `src/claude/query-handle.ts`

```typescript
import type { AppConfig } from "../types.js";
import type { SDKMessageLike } from "./session.js";
import type { PermissionResponse } from "./permission-broker.js";

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * 由 ClaudeSession 每轮构造的权限回调 closure。SDK 在收到 Claude
 * 的 tool_use 事件时调用它来询问用户决策。
 *
 * - `toolName` 是要调用的工具名,例如 "Bash"、"Edit"
 * - `input` 是工具调用的参数（结构由工具决定）
 * - `opts.signal` 是 SDK 侧的 AbortSignal；当 session 调
 *   `handle.interrupt()` 时会 fire,broker 的定时器应该检查它
 *   （或者直接依赖 broker.cancelAll 主动 resolve）
 * - `opts.toolUseID` 是 SDK 侧的工具调用 id,当前只用于日志
 *
 * Contract: 这个函数 MUST NOT throw under normal operation.
 * 超时/取消/拒绝都通过返回 `{behavior:"deny"}` 表达。
 */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
) => Promise<{ behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }>;

export interface QueryHandle {
  readonly messages: AsyncIterable<SDKMessageLike>;
  interrupt(): Promise<void>;
  /**
   * 对应 SDK `query.setPermissionMode(mode)`。
   * 由 session 在处理 `allow_turn` / `allow_session` 时调用,
   * 改变本轮剩余 tool_use 的默认允许规则。
   */
  setPermissionMode(mode: ClaudeQueryOptions["permissionMode"]): void;
}

export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
  canUseTool: CanUseToolFn;
}) => QueryHandle;
```

**注意**：`CanUseToolFn` 的返回类型只有 `allow | deny`（SDK 协议限定），不是 broker 的 4 变体 `PermissionResponse`。session 在 `canUseTool` closure 里负责把 broker 的 `allow_turn` / `allow_session` 变体 "翻译" 成 SDK 能理解的 `allow` + 副作用。

### 3.2 `src/claude/permission-broker.ts`

```typescript
export interface PermissionRequest {
  toolName: string;
  input: unknown;
  chatId: string;
  /** 触发这轮的用户 open_id — 只有 ta 能点按钮。 */
  ownerOpenId: string;
  /** 触发这轮的用户消息 id — 权限卡片用 replyCard 挂在它下面。 */
  parentMessageId: string;
}

/**
 * Broker 内部 4 变体。session 把前两个直接返回给 SDK,
 * 把后两个解释成 `allow` + 副作用。
 */
export type PermissionResponse =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "allow_turn" }
  | { behavior: "allow_session" };

export type CardActionResult =
  | { kind: "resolved" }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

export type CardChoice = "allow" | "deny" | "allow_turn" | "allow_session";

export interface PermissionBroker {
  /**
   * SDK 的 canUseTool 调入口。发权限卡片,启超时定时器,
   * 等待用户决策。Promise MUST NOT reject under normal operation.
   */
  request(req: PermissionRequest): Promise<PermissionResponse>;

  /**
   * 卡片按钮回调路由。gateway 收到 card.action.trigger 后调这个。
   * 返回值供 gateway 决定是否回 toast / 忽略。
   */
  resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult>;

  /**
   * 一次性 deny 所有 pending。session 的 /stop / !前缀路径调这个。
   * `reason` 会作为 tool_result 的 deny message 让 Claude 看到。
   * 同时清掉所有定时器,patch 所有挂起的卡片到"已取消"。
   */
  cancelAll(reason: string): void;
}
```

### 3.3 `FeishuPermissionBroker` 实现骨架

```typescript
import crypto from "node:crypto";

interface PendingRequest {
  requestId: string;
  deferred: Deferred<PermissionResponse>;
  timeoutTimer: ReturnType<Clock["setTimeout"]>;
  warnTimer: ReturnType<Clock["setTimeout"]>;
  cardMessageId: string;
  parentMessageId: string;
  ownerOpenId: string;
  toolName: string;
  createdAt: number;
}

export class FeishuPermissionBroker implements PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly feishu: FeishuClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly config: {
      timeoutMs: number;
      warnBeforeMs: number;
    },
  ) {}

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    const requestId = crypto.randomUUID();
    const deferred = createDeferred<PermissionResponse>();

    // 1. 发权限卡片
    const card = buildPermissionCard({
      requestId,
      toolName: req.toolName,
      input: req.input,
      ownerOpenId: req.ownerOpenId,
    });
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(req.parentMessageId, card);
      cardMessageId = res.messageId;
    } catch (err) {
      // 卡片发不出去 = broker 没法工作 → 直接 deny
      this.logger.error(
        { err, tool_name: req.toolName, parent_message_id: req.parentMessageId },
        "permission card replyCard failed — auto-denying",
      );
      return { behavior: "deny", message: "Failed to send permission card; auto-denied." };
    }

    // 2. 启定时器
    const timeoutTimer = this.clock.setTimeout(() => {
      this.autoDeny(requestId);
    }, this.config.timeoutMs);
    const warnTimer = this.clock.setTimeout(() => {
      this.sendWarnReminder(requestId);
    }, this.config.timeoutMs - this.config.warnBeforeMs);

    // 3. 注册 pending
    this.pending.set(requestId, {
      requestId,
      deferred,
      timeoutTimer,
      warnTimer,
      cardMessageId,
      parentMessageId: req.parentMessageId,
      ownerOpenId: req.ownerOpenId,
      toolName: req.toolName,
      createdAt: this.clock.now(),
    });

    return deferred.promise;
  }

  async resolveByCard(args): Promise<CardActionResult> {
    const p = this.pending.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }
    this.clearTimers(p);
    this.pending.delete(args.requestId);

    // patch 卡片到"已处理"变体 — 失败 warn 不 throw
    try {
      await this.feishu.patchCard(
        p.cardMessageId,
        buildPermissionCardResolved({
          toolName: p.toolName,
          choice: args.choice,
          resolverOpenId: args.senderOpenId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        { err, card_message_id: p.cardMessageId, request_id: args.requestId },
        "permission card patch failed — continuing",
      );
    }

    switch (args.choice) {
      case "allow":          p.deferred.resolve({ behavior: "allow" }); break;
      case "deny":           p.deferred.resolve({ behavior: "deny", message: "User denied the tool call." }); break;
      case "allow_turn":     p.deferred.resolve({ behavior: "allow_turn" }); break;
      case "allow_session":  p.deferred.resolve({ behavior: "allow_session" }); break;
    }
    return { kind: "resolved" };
  }

  cancelAll(reason: string): void {
    for (const [id, p] of this.pending.entries()) {
      this.clearTimers(p);
      p.deferred.resolve({ behavior: "deny", message: reason });
      // patch 卡片到"已取消" — 失败 warn 不 throw,不 await（避免阻塞 stop 路径）
      void this.feishu.patchCard(
        p.cardMessageId,
        buildPermissionCardCancelled({ toolName: p.toolName, reason }),
      ).catch((err) => {
        this.logger.warn({ err, request_id: id }, "cancel patch failed — ignoring");
      });
    }
    this.pending.clear();
  }

  private autoDeny(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.clearTimers(p);
    this.pending.delete(requestId);
    p.deferred.resolve({
      behavior: "deny",
      message: `Permission request timed out after ${Math.round(this.config.timeoutMs / 1000)}s.`,
    });
    void this.feishu.patchCard(
      p.cardMessageId,
      buildPermissionCardTimedOut({ toolName: p.toolName }),
    ).catch((err) => {
      this.logger.warn({ err, request_id: requestId }, "timeout patch failed");
    });
  }

  private sendWarnReminder(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    const secondsLeft = Math.round(this.config.warnBeforeMs / 1000);
    void this.feishu.replyText(
      p.parentMessageId,
      `⏰ 权限请求（${p.toolName}）将在 ${secondsLeft}s 后自动拒绝`,
    ).catch((err) => {
      this.logger.warn({ err, request_id: requestId }, "warn reminder failed");
    });
  }

  private clearTimers(p: PendingRequest): void {
    this.clock.clearTimeout(p.timeoutTimer);
    this.clock.clearTimeout(p.warnTimer);
  }
}
```

**注意**：
- broker 不持有 session 引用，session 通过 `broker.cancelAll(reason)` 主动调用
- broker 的 `request()` 在卡片发送失败时直接返回 deny，不把整个 session 搞崩
- 所有 patch 失败都 warn + 继续，只有初始 send 失败才 deny（因为没 cardMessageId 就没法后续 patch）
- `cancelAll` 的 patchCard 用 `void` + `.catch` 而不是 await，避免在 stop 路径阻塞

### 3.4 `ClaudeSession` 改动

**字段变化**
- 删除 `pendingPermission: Deferred<PermissionResponse> | null`
- 新增 `sessionAcceptEditsSticky = false`
- `QueuedInput` 新增两个字段：
  ```typescript
  export interface QueuedInput {
    text: string;
    senderOpenId: string;       // NEW
    parentMessageId: string;    // NEW
    emit: EmitFn;
    done: Deferred<void>;
    readonly seq: number;
  }
  ```

**`submit()` 签名变化**

Phase 4 的 `submit(input: CommandRouterResult, emit: EmitFn)` 只接 parseInput 的返回值。Phase 5 需要多带 `senderOpenId` 和 `parentMessageId`（不是 `parseInput` 知道的东西），所以 `submit` 的第一参数从 `CommandRouterResult` 扩成：

```typescript
type SubmitInput = CommandRouterResult & {
  senderOpenId: string;
  parentMessageId: string;
};
```

`CommandRouterResult` 本身不变（`parseInput` 不知道这两个字段）。由 `src/index.ts` 的 dispatcher 在调 `submit` 前拼接：

```typescript
const parsed = parseInput(msg.text);
if (parsed.kind === "stop") {
  await session.stop(emit);
  return;
}
const outcome = await session.submit(
  { ...parsed, senderOpenId: msg.senderOpenId, parentMessageId: msg.messageId },
  emit,
);
```

`kind: "stop"` 走 `session.stop()` 而不是 `session.submit()`，所以 `stop` 分支不需要两个新字段。`run` 和 `interrupt_and_run` 两个分支走 `submit`，`QueuedInput` 从 `SubmitInput` 取字段入队。

**`runTurn` 里构造 `canUseTool`**

```typescript
private async runTurn(input: QueuedInput, ...): Promise<void> {
  const permissionMode = this.sessionAcceptEditsSticky
    ? "acceptEdits"
    : this.config.defaultPermissionMode;

  // canUseTool closure —— 捕获 input 是为了拿 senderOpenId / parentMessageId
  const canUseTool: CanUseToolFn = async (toolName, rawInput, _sdkOpts) => {
    // 进 awaiting_permission
    await this.mutex.run(async () => {
      this.state = "awaiting_permission";
    });

    let response: PermissionResponse;
    try {
      response = await this.permissionBroker.request({
        toolName,
        input: rawInput,
        chatId: this.chatId,
        ownerOpenId: input.senderOpenId,
        parentMessageId: input.parentMessageId,
      });
    } finally {
      // 无论 resolve 还是异常,都回 generating
      await this.mutex.run(async () => {
        if (this.state === "awaiting_permission") {
          this.state = "generating";
        }
      });
    }

    switch (response.behavior) {
      case "allow":
        return { behavior: "allow" };
      case "deny":
        return { behavior: "deny", message: response.message };
      case "allow_turn":
        this.currentTurn?.handle.setPermissionMode("acceptEdits");
        return { behavior: "allow" };
      case "allow_session":
        this.currentTurn?.handle.setPermissionMode("acceptEdits");
        this.sessionAcceptEditsSticky = true;
        return { behavior: "allow" };
    }
  };

  const handle = this.queryFn({
    prompt: input.text,
    options: { cwd: ..., model: ..., permissionMode, settingSources: ... },
    canUseTool,
  });

  // ... 其余流程跟 Phase 4 一样
}
```

**`stop()` / `submitInterruptAndRun()` 里调 `broker.cancelAll`**

Phase 4 这两个方法里有 `permissionToDeny: Deferred<PermissionResponse> | null` 本地变量 + "resolve 后走 handle.interrupt" 的流程。Phase 5 把它改成：

```typescript
// 旧（Phase 4）:
if (this.state === "awaiting_permission") {
  permissionToDeny = this.pendingPermission;
  this.pendingPermission = null;
  this.state = "generating";
}
// ... 锁外 ...
if (permissionToDeny !== null) {
  permissionToDeny.resolve({ behavior: "deny", message: "..." });
}

// 新（Phase 5）:
let needCancelPending = false;
if (this.state === "awaiting_permission") {
  this.state = "generating";
  needCancelPending = true;
}
// ... 锁外 ...
if (needCancelPending) {
  this.permissionBroker.cancelAll("User issued /stop");  // 或 "User sent ! prefix"
}
```

### 3.5 `src/feishu/gateway.ts` 改动

新增 `card.action.trigger` 订阅和 `onCardAction` 回调选项：

```typescript
export type CardActionHandler = (action: {
  senderOpenId: string;
  value: Record<string, unknown>;
}) => Promise<unknown>;

export interface FeishuGatewayOptions {
  // ... 原有字段
  onCardAction: CardActionHandler;   // NEW
}

// start() 里的 dispatcher 注册:
const dispatcher = new EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => { /* 原有 */ },
  "card.action.trigger": async (data: unknown) => {
    const event = data as CardActionEvent;
    const decision = this.access.check(event.operator.open_id);
    if (!decision.allowed) {
      this.logger.warn(
        { open_id: event.operator.open_id },
        "Unauthorized card action, ignoring",
      );
      return {};
    }
    try {
      return await this.onCardAction({
        senderOpenId: event.operator.open_id,
        value: event.action.value,
      });
    } catch (err) {
      this.logger.error({ err }, "Card action handler threw");
      return {};
    }
  },
});
```

**注意**：`CardActionEvent` 的完整形状需要 plan 阶段对着 `@larksuiteoapi/node-sdk` 的类型或文档确认，上面只是结构示意。

### 3.6 `src/feishu/cards/permission-card.ts` 新文件

职责：构建四种变体的权限卡片 —— pending（带 4 按钮）、resolved、cancelled、timed out。

**Pending 卡片结构（v2.0 schema）**：
- `header.title`: `🔐 权限请求 · <toolName>`
- `header.template`: `yellow`
- `body.elements`:
  1. markdown: `Claude 要调用工具 **<toolName>**:`
  2. markdown: 工具 input 的代码块预览（截断到 2048 字符）
  3. column_set: 2 列，分别放 `[✅ 允许]` / `[❌ 拒绝]`
  4. column_set: 2 列，分别放 `[✅ 本轮 acceptEdits]` / `[✅ 会话 acceptEdits]`
  5. markdown: `<font color="grey">只有发起者可点击 · 5 分钟未响应自动拒绝</font>`

**按钮 value 字段**：`{ kind: "permission", request_id: "<uuid>", choice: "allow"|"deny"|"allow_turn"|"allow_session" }`

**Resolved / Cancelled / Timed out 变体**：按钮全部移除，替换成单行 markdown：
- Resolved: `✅ 已由 @<user> 选择：<choice 文案>`
- Cancelled: `🛑 已取消（<reason>）`
- Timed out: `⏰ 已超时自动拒绝`

### 3.7 `src/claude/sdk-query.ts` 新文件

替换 `src/claude/cli-query.ts`。核心结构：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn, QueryHandle, CanUseToolFn } from "./query-handle.js";

export interface SdkQueryFnOptions {
  cliPath: string;
  logger: Logger;
}

export function createSdkQueryFn(opts: SdkQueryFnOptions): QueryFn {
  return (params) => {
    const abort = new AbortController();
    let settled = false;

    const q = query({
      prompt: params.prompt,
      options: {
        cwd: params.options.cwd,
        model: params.options.model,
        permissionMode: params.options.permissionMode,
        settingSources: params.options.settingSources,
        canUseTool: params.canUseTool,
        pathToClaudeCodeExecutable: opts.cliPath,
        abortController: abort,
        env: { ...process.env },
      },
    });

    const messages: AsyncIterable<SDKMessageLike> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const msg of q) {
            yield msg as SDKMessageLike;
          }
        } finally {
          settled = true;
        }
      },
    };

    return {
      messages,
      interrupt: async () => {
        if (settled) return;
        abort.abort();
        // 等待 q 的 iterator 自然结束后 resolve
        // 具体实现 plan 阶段细化(可能需要包装 messages 暴露一个 done Promise)
      },
      setPermissionMode: (mode) => {
        // SDK 的 q 对象应该有 setPermissionMode 方法,类型可能需要 any 逃逸
        // 详见 plan 阶段的 SDK 类型 check
        (q as { setPermissionMode?: (m: string) => void }).setPermissionMode?.(mode);
      },
    };
  };
}
```

**未解决细节（留给 plan）**：
- `interrupt()` 的 drain 语义精确实现
- `setPermissionMode` 的类型逃逸能否消除
- `@anthropic-ai/claude-agent-sdk` 的具体 API 名称 / 参数形状需要对照实际版本确认（写 plan 之前先 `pnpm add` 一下，看类型声明）

---

## 4. 配置变更

### 4.1 新增配置项

`~/.claude-feishu-channel/config.toml` 和 `config.example.toml` 的 `[claude]` 节添加：

```toml
[claude]
# ... 原有字段
default_permission_mode = "default"         # ← 从 bypassPermissions 改
permission_timeout_seconds = 300
permission_warn_before_seconds = 60
```

### 4.2 `src/types.ts` 扩展

```typescript
interface ClaudeConfig {
  // ... 原有字段
  permissionTimeoutMs: number;      // 从 permission_timeout_seconds * 1000
  permissionWarnBeforeMs: number;   // 从 permission_warn_before_seconds * 1000
}
```

### 4.3 `src/config.ts` Zod schema 扩展

加两个 `z.number().int().positive()` 字段，默认值分别是 300 和 60。Zod schema 名字对照 `src/config.ts` 现有命名约定。

### 4.4 用户 config 迁移提示

bot 启动时如果 `default_permission_mode === "bypassPermissions"`，在日志里打一条 `warn` 级别的提示：`Phase 5 shipped — permission brokering is active when default_permission_mode != "bypassPermissions". Your current config bypasses the broker.`（不强制 fail，用户可能故意想继续 bypass）

---

## 5. 测试策略

### 5.1 新增测试文件

- `test/unit/claude/sdk-query.test.ts`：mock `@anthropic-ai/claude-agent-sdk` 的 `query` 导出，验证参数透传、abort、setPermissionMode
- `test/unit/claude/permission-broker.test.ts`：broker 全路径
- `test/unit/feishu/cards/permission-card.test.ts`：卡片构建器

### 5.2 `permission-broker.test.ts` 必须覆盖

1. happy path：`request` 发卡片 → 返回 Promise pending → `resolveByCard(allow)` → Promise 返回 `{allow}` + 定时器被清 + patchCard 被调
2. `resolveByCard` 四种 choice 的 PermissionResponse 正确
3. 非 owner 点击：`senderOpenId !== ownerOpenId` → 返回 `{kind: "forbidden"}` + Deferred 不动
4. `not_found`：`requestId` 不在 pending map → 返回 `{kind: "not_found"}`
5. 超时自动 deny：FakeClock 推进 `timeoutMs` → Deferred 解析为 deny，message 含超时文案 + 卡片被 patch 成 timed out 变体
6. 超时前 warn：FakeClock 推进 `timeoutMs - warnBeforeMs` → `replyText` 被调，内容含 `⏰`
7. `cancelAll` 一次性 deny：2 个 pending 同时存在 → `cancelAll("reason")` → 两个 Deferred 都解析为 deny，pending map 清空
8. `replyCard` 失败：mock feishu.replyCard 抛错 → `request` 返回 `{deny}` 而不是抛出
9. `patchCard` 失败（resolve 路径）：mock patch 抛 → `resolveByCard` 仍返回 `{resolved}`（patch 失败不阻塞 resolve）
10. `patchCard` 失败（cancel 路径）：mock patch 抛 → `cancelAll` 不抛（void catch）

### 5.3 `session-state-machine.test.ts` 改写

- 删除所有使用 `_testEnterAwaitingPermission` / `_testExitAwaitingPermission` 的 case
- 改用 `FakePermissionBroker`，session 构造时注入它
- 测试新场景：
  - `canUseTool` → broker.request 被调，参数正确（toolName/input/chatId/ownerOpenId/parentMessageId 都对）
  - broker 返回 `allow` → canUseTool 返回 `{allow}`
  - broker 返回 `deny` → canUseTool 返回 `{deny, message}`
  - broker 返回 `allow_turn` → `handle.setPermissionMode("acceptEdits")` 被调，canUseTool 返回 `{allow}`，sticky 保持 false
  - broker 返回 `allow_session` → setPermissionMode 被调 + sticky 变 true，canUseTool 返回 `{allow}`
  - sticky 打开的情况下下一轮 `runTurn` 的 QueryOptions.permissionMode 是 `acceptEdits`
  - `/stop` 在 awaiting_permission → `broker.cancelAll` 被调 + handle.interrupt 被调 + 状态回 idle
  - `!` 前缀在 awaiting_permission → `broker.cancelAll` 被调 + 队列被清 + 新 input 入队 + 旧 turn interrupt

### 5.4 `FakePermissionBroker`

```typescript
class FakePermissionBroker implements PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  readonly cancelCalls: string[] = [];
  private resolver: ((r: PermissionResponse) => void) | null = null;

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    this.requests.push(req);
    return new Promise((resolve) => { this.resolver = resolve; });
  }

  /** 测试 helper —— 手动 resolve 最近一次 request */
  fakeResolve(response: PermissionResponse): void {
    const r = this.resolver;
    if (!r) throw new Error("no pending resolver");
    this.resolver = null;
    r(response);
  }

  async resolveByCard(): Promise<CardActionResult> {
    throw new Error("resolveByCard not expected in session tests");
  }

  cancelAll(reason: string): void {
    this.cancelCalls.push(reason);
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ behavior: "deny", message: reason });
    }
  }
}
```

### 5.5 `FakeQueryHandle` 扩展

`FakeQueryFn` 保存 `params.canUseTool` 的引用，`FakeQueryHandle` 暴露一个 `triggerCanUseTool(toolName, input)` 测试方法来模拟 SDK 触发回调。同样加 `setPermissionMode` 方法，记录调用历史供断言。

### 5.6 Phase 1-4 测试 fixture 调整

`QueuedInput` 加了两个字段 → 所有构造 `QueuedInput` 的测试都要补 `senderOpenId` + `parentMessageId`。大部分用一个常量 fixture（`"ou_test"` / `"om_test"`）就够。

`SubmitInput` 的 dispatcher 侧改动 → router 测试不变，index.ts 没有集成测试，靠 E2E 兜底。

### 5.7 E2E checklist（Phase 5 上线后手动验证）

- [ ] 发"帮我 `ls` 一下当前目录" → 权限卡片出现 → 点允许 → 看到 ls 结果
- [ ] 同上 → 点拒绝 → Claude 收到 deny 后继续对话（例如说"好的，那我就不运行了"）
- [ ] 点本轮 acceptEdits → 之后连发多个 Edit 操作 → 不再弹卡 → 再让它跑 Bash → 弹卡（因为 Bash 不被 acceptEdits 涵盖）
- [ ] 点会话 acceptEdits → 新开一轮仍然不弹 Edit 卡 → 重启 bot 后恢复弹卡
- [ ] 权限卡片挂着 5 分钟不点 → 自动拒绝，Claude 收到超时说明
- [ ] 权限卡片挂着 4 分钟 → 收到"⏰ 将在 60s 后..."提醒
- [ ] 权限卡片挂着时发 `/stop` → 卡片 patch 成"已取消" + Deferred 解析 deny + turn 结束
- [ ] 权限卡片挂着时发 `! 另一个请求` → 卡片 patch 成"已取消" + 队列清空 + 新请求开始 + 旧 turn 中断
- [ ] 群里另一个用户（非 owner）点按钮 → 无反应（log 里有 forbidden 记录）
- [ ] 自定义 `ANTHROPIC_BASE_URL` 仍然生效（看 turn 能否跑完）
- [ ] config 里保留 `bypassPermissions` → bot 启动 warn 日志 + 行为等同 Phase 4（不弹卡）

---

## 6. 文件清单

### 新增

- `src/claude/sdk-query.ts`
- `src/feishu/cards/permission-card.ts`
- `test/unit/claude/sdk-query.test.ts`
- `test/unit/claude/permission-broker.test.ts`
- `test/unit/feishu/cards/permission-card.test.ts`

### 修改

- `src/claude/query-handle.ts`：`CanUseToolFn` + `QueryHandle.setPermissionMode` + `QueryFn` 签名扩展
- `src/claude/permission-broker.ts`：`PermissionRequest` 加 `parentMessageId` + `PermissionResponse` 扩成 4 变体 + 新接口方法 `resolveByCard` / `cancelAll` + 新实现 class `FeishuPermissionBroker` + 删 `NullPermissionBroker`
- `src/claude/session.ts`：
  - 删 `pendingPermission` 字段
  - 删 `_testEnterAwaitingPermission` / `_testExitAwaitingPermission` 测试 seam
  - 新增 `sessionAcceptEditsSticky` 字段
  - `QueuedInput` 加 `senderOpenId` / `parentMessageId`
  - `runTurn` 构造 `canUseTool` closure
  - `stop()` / `submitInterruptAndRun()` 改用 `broker.cancelAll`
  - `runTurn` 消费 sticky 标志选 `permissionMode`
- `src/feishu/gateway.ts`：新增 `card.action.trigger` 订阅 + `onCardAction` 选项
- `src/feishu/card-types.ts`：补 `column_set` / `button` / `header` 类型（按需）
- `src/types.ts`：`ClaudeConfig` 加两个超时字段
- `src/config.ts`：Zod schema 加两个字段 + 默认值
- `src/index.ts`：
  - 构造 `FeishuPermissionBroker`
  - 构造 `createSdkQueryFn`（替换 `createCliQueryFn`）
  - 传 `senderOpenId` / `parentMessageId` 到 `session.submit`
  - 注册 `gateway.onCardAction` → `broker.resolveByCard` 路由
  - 启动时检测 `bypassPermissions` 并 warn
- `config.example.toml`：示例更新
- `package.json`：加 `@anthropic-ai/claude-agent-sdk` 依赖
- `test/unit/claude/session-state-machine.test.ts`：改写（见 §5.3）
- 所有涉及 `QueuedInput` 构造的测试：补两个字段

### 删除

- `src/claude/cli-query.ts`
- `test/unit/claude/cli-query.test.ts`

---

## 7. 开放问题（留给 plan 阶段解决）

1. **`@anthropic-ai/claude-agent-sdk` 的具体 API 形状**：设计基于对文档的阅读，实际 `query()` 返回对象的 `setPermissionMode` 方法名、`canUseTool` 的 opts 字段名、`abortController` 的接入方式需要 `pnpm add` 后查 `.d.ts` 确认。plan 阶段的第一步就是加依赖 + 写一个最小 smoke 测试。
2. **`sdk-query.ts` 的 `interrupt()` 的 drain 语义**：abort 后如何可靠地等 iterator 结束？SDK 是否有 "done" 回调 / Promise？需要看源码。
3. **`CardActionEvent` 的精确 TypeScript 类型**：`@larksuiteoapi/node-sdk` 的 type 导出可能有，如果没有就自己写 interface 并把 `as unknown as` 的强转集中在 gateway 里。
4. **Feishu `card.action.trigger` 是否需要额外的 webhook 配置**：目前 bot 用 WebSocket 长连接，按钮事件理论上走同一条连接。但开发者后台可能需要开启"卡片交互"权限 scope。plan 阶段验证。
5. **`button` 组件的 `value` 字段是否会被 Feishu 截断**：超长 value 是否有限制？当前 value 里只有 uuid + 常量 choice，应该远低于任何限制，但 plan 阶段确认。
6. **`patchCard` 的 `update_multi` 要求**：permission card 发送时 `config.update_multi: true` 必须 set，否则后续 patch 被拒。plan 阶段在 builder 里加上。
7. **Clock 的 `setTimeout` / `clearTimeout` 签名**：Phase 4 的 Clock 接口是否已经有这两个方法？没有的话要加。
8. **超长 tool input 的 UX**：2KB 截断是否合理？某些 Bash 命令可能正好挂在这个边界。plan 阶段看 Phase 3 的 `inline_max_bytes` 参考值。
9. **非 owner 点击的反馈方式**：MVP 只 log 不骚扰用户；`card.action.trigger` 的 response 是否支持 toast？plan 阶段查文档。

---

## 8. 不做的事情（拒绝的扩展）

- 不做细粒度 `PermissionUpdate`（具体工具 + 具体参数的白名单）→ Phase 7+
- 不做权限策略的持久化（sticky 标志只在内存）→ 进程重启就重置
- 不做 `/mode` 命令显式切换 → Phase 6
- 不做 `/new` 重置会话 → Phase 6
- 不做 card action 的 toast 反馈（非 owner 点击只 log）→ 如果 plan 阶段发现 lark-sdk 零成本支持，可以顺手做
- 不做多租户 broker / 多 allowed_open_id 的并发 broker 实例 → 单用户场景
- 不做 `canUseTool` 超时的"智能重试"—— 超时就 deny 到底，Claude 自己决定下一步

---

## 9. 与既有文档的关系

- `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` §5-6 的状态表和权限桥说明是**当前文档的上游**，当前文档的具体接口定义和测试策略是对它的**细化**。当两者矛盾时（例如按钮数量从 3 变 4），以当前文档为准。
- §18 的开放问题 1（"始终允许"粒度）本文档的决议：**MVP 用 `setPermissionMode('acceptEdits')` + 会话级 sticky 布尔**，细粒度 `PermissionUpdate` 推迟到 Phase 7+。
- Phase 4 的状态机 test seam `_testEnterAwaitingPermission` 和 `pendingPermission` 字段被本阶段删除 —— 它们作为 Phase 5 的占位接口在 Phase 4 spec 里是故意留下的脚手架。
