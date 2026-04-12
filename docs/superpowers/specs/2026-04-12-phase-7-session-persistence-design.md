# Phase 7：Session Persistence 设计文档

- **创建日期**：2026-04-12
- **状态**：设计草案（待实施）
- **作者**：zhaodongsheng × Claude
- **上游依赖**：`docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` §10
- **下游产出**：`docs/superpowers/plans/2026-04-12-phase-7-session-persistence.md`

---

## 1. 目标

实现 §10 中的会话持久化：session_id 捕获、StateStore 写入（即时 + 防抖）、启动加载、TTL 清理、崩溃恢复通知、`/resume` 和 `/sessions` 命令。

**成功标准**：
1. 每个 Claude 会话的 `session_id` 从 SDK 流中捕获并存储
2. 会话创建/删除/配置变更立即写入 `state.json`（Scenario A）
3. `lastActiveAt` 更新防抖 30s 写入（Scenario B）
4. 启动时加载 `state.json`，清理超过 TTL 的会话记录
5. 非正常重启后向活跃会话的飞书 chat 发送恢复通知
6. `/sessions` 列出所有已知会话
7. `/resume <id>` 将当前 chat 绑定到已有会话
8. 正常关闭时写入 `lastCleanShutdown: true`
9. 所有现有测试 + ~25 条新测试全绿

**非目标（Phase 8+）**：
- `/config set <key> <value>`（运行时配置修改）
- `/config set --persist`（TOML 回写）

---

## 2. session_id 捕获

### 2.1 SDKMessageLike 扩展

`SDKMessageLike` 新增可选字段：

```ts
export interface SDKMessageLike {
  // ...existing fields...
  session_id?: string;
}
```

SDK 的每条消息都携带 `session_id: string`。我们的 `SDKMessageLike` 将其声明为可选以兼容测试 fake。

### 2.2 Session 内捕获

`ClaudeSession` 新增私有字段 `claudeSessionId?: string`。

在 `runTurn` 的 `for await (const msg of handle.messages)` 循环中，在第一条携带 `session_id` 的消息到达时捕获：

```ts
if (msg.session_id && !this.claudeSessionId) {
  this.claudeSessionId = msg.session_id;
  this.onSessionIdCaptured?.();
}
```

`onSessionIdCaptured` 是一个可选回调，由 SessionManager 注入，用于触发 Scenario A 持久化写入。

### 2.3 SessionStatus 扩展

```ts
export interface SessionStatus {
  // ...existing fields...
  claudeSessionId?: string;
}
```

`getStatus()` 返回 `claudeSessionId: this.claudeSessionId`。

### 2.4 resume 选项透传

`ClaudeQueryOptions` 新增 `resume?: string`。

`processLoop` 构建 `queryFn` 参数时：
```ts
const handle = this.queryFn({
  prompt: next.text,
  options: {
    // ...existing...
    resume: this.claudeSessionId,
  },
  canUseTool: ...,
});
```

`createSdkQueryFn` 中将 `resume` 转发到 SDK 的 `query()` options。

---

## 3. StateStore 写入

### 3.1 SessionRecord

```ts
interface SessionRecord {
  claudeSessionId: string;
  cwd: string;
  permissionMode: string;
  model: string;
  createdAt: string;   // ISO 8601
  lastActiveAt: string; // ISO 8601
}
```

`state.json` 的 `sessions` 字段类型为 `Record<string, SessionRecord>`（key = feishuChatId）。

### 3.2 写入触发

**Scenario A（即时）**— 结构变更：
- session_id 首次捕获（`onSessionIdCaptured` 回调）
- `/new` 删除会话
- `/mode` 或 `/model` 覆盖变更
- `/cd` 确认后 cwd 变更
- `/resume` 绑定新会话

每次即时写入前取消任何待执行的防抖写入。

**Scenario B（防抖 30s）**— 活跃度心跳：
- 每轮 `runTurn` 完成后，Session 更新内部 `lastActiveAt` 时间戳
- SessionManager 启动 30s 防抖定时器，到期后将所有 session 的快照写入 state.json
- 如果 30s 内有新的轮次完成，重置定时器

### 3.3 快照构建

SessionManager 遍历所有活跃 session 的 `getStatus()`，结合 `claudeSessionId`，构建完整的 `sessions` 记录。仅写入有 `claudeSessionId` 的会话（尚未收到 SDK 响应的会话不写入）。

### 3.4 SessionManager 新增依赖

```ts
export interface ClaudeSessionManagerOptions {
  // ...existing...
  stateStore: StateStore;
  feishuClient: FeishuClient; // for crash recovery notifications
}
```

---

## 4. 启动加载 + TTL 清理

### 4.1 启动流程

1. `stateStore.load()` → 读取 state.json
2. `stateStore.markUncleanAtStartup(state)` → 标记为非正常状态（已有实现）
3. TTL 清理：过滤 `state.sessions`，移除 `lastActiveAt` 早于 `now - sessionTtlDays` 天的记录
4. 将存活的记录存入 `SessionManager.staleRecords: Map<string, SessionRecord>`
5. 立即保存清理后的 state

### 4.2 懒恢复

`getOrCreate(chatId)` 检查 `staleRecords`：
- 有记录 → 用记录中的 `cwd`、`permissionMode`、`model` 创建 `ClaudeSession`，设置 `claudeSessionId` 以便首次 `query()` 使用 `resume`。从 `staleRecords` 中移除。
- 无记录 → 正常创建（现有逻辑）

`cwdOverrides`（Phase 6）优先级高于 stale record 的 cwd。

### 4.3 配置扩展

`PersistenceSchema` 新增：
```ts
session_ttl_days: z.number().int().positive().default(30),
```

`AppConfig.persistence` 新增 `sessionTtlDays: number`。

---

## 5. 崩溃恢复 + 关闭处理

### 5.1 崩溃恢复

启动加载后，检查 `lastCleanShutdown`：

- `true` → 无需操作
- `false` → 非正常重启。对每个 stale record 中 `lastActiveAt` 在最近 1 小时内的会话，向对应 chatId 发送通知：

  ```
  ⚠️ 上次 bot 异常重启，已恢复会话。请检查上一轮的执行结果是否完整
  ```

  使用 `feishuClient.sendText(chatId, text)`（主动发送，非回复）。

发送失败不阻塞启动——log.warn 后继续。

### 5.2 关闭处理

在 `index.ts` 中注册 `SIGTERM` 和 `SIGINT` 处理器：

```ts
const shutdown = async () => {
  await stateStore.save(buildCurrentState());
  stateStore.markCleanShutdown(state);
  await stateStore.save(state);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

关闭时先保存完整快照（flush 防抖），再标记 clean shutdown。

### 5.3 过期卡片

非正常重启后，旧进程的 permission/question broker 条目已丢失（内存）。用户点击过期卡片 → broker 返回 `not_found` → 已有逻辑正确处理，无需额外代码。

---

## 6. `/resume` 和 `/sessions` 命令

### 6.1 Router 扩展

`KNOWN_COMMANDS` 新增 `"resume"` 和 `"sessions"`。

`ParsedCommand` 新增：
```ts
| { name: "sessions" }
| { name: "resume"; target: string }
```

解析规则：
- `/sessions` → `{ name: "sessions" }`
- `/resume <id>` → `{ name: "resume", target: trimmed }`（id 非空）
- `/resume`（无参数）→ `unknown_command`

### 6.2 `/sessions` 语义

| 状态要求 | 行为 |
|---|---|
| 任意 | 收集所有活跃 session 的 `getStatus()` + staleRecords。格式化文本列表：chatId（截短）、cwd、model、lastActiveAt、状态（active/stale）。无记录时回复 "暂无会话记录"。 |

### 6.3 `/resume <target>` 语义

| 状态要求 | 行为 |
|---|---|
| idle | 在活跃 sessions 和 staleRecords 中按 `claudeSessionId` 或 `chatId` 查找 target。未找到 → "未找到会话"。是当前 chat 自身 → "已经在该会话中"。找到 → 删除当前 chat 的会话，将 target 的 SessionRecord 复制为当前 chat 的 stale record（下条消息懒恢复），回复 "已恢复会话 `<id短>`, 工作目录: `<cwd>`"。触发 Scenario A 写入。 |

### 6.4 SessionManager 查找接口

新增方法：

```ts
findSession(target: string): { chatId: string; record: SessionRecord } | undefined
  // 先按 claudeSessionId 匹配活跃 sessions，再匹配 staleRecords
  // 再按 chatId 精确匹配

getAllSessions(): Array<{ chatId: string; record: SessionRecord; active: boolean }>
  // 合并活跃 sessions 的 getStatus() 转 SessionRecord + staleRecords
```

---

## 7. 测试策略

### 7.1 Session 测试

扩展 `test/unit/claude/session-state-machine.test.ts`：
- `session_id` 从第一条流消息捕获 → `getStatus().claudeSessionId`
- `onSessionIdCaptured` 回调触发
- `resume` 选项在有 `claudeSessionId` 时传入 `queryFn`
- 无 `claudeSessionId` 时不传 `resume`

### 7.2 SessionManager 测试

扩展 `test/unit/claude/session-manager.test.ts`：
- 即时写入：session_id 捕获后 save 被调用
- 即时写入：delete 后 save 被调用
- 防抖写入：turn 完成后 30s 防抖触发 save
- 即时写入取消防抖
- 启动加载：staleRecords 从 state 填充
- TTL 清理：过期记录被移除
- `getOrCreate` 使用 stale record 的 cwd/mode/model/sessionId
- `findSession` 按 sessionId 和 chatId 查找
- `getAllSessions` 合并活跃 + stale
- 崩溃恢复：`lastCleanShutdown=false` → sendText 被调用

### 7.3 Router 测试

扩展 `test/unit/commands/router.test.ts`：
- `/sessions` → command
- `/resume abc-123` → command with target
- `/resume` 无参数 → unknown_command

### 7.4 Dispatcher 测试

扩展 `test/unit/commands/dispatcher.test.ts`：
- `/sessions` 无会话 → "暂无会话记录"
- `/sessions` 有会话 → 列表含 chatId/cwd
- `/resume` 有效 target → 成功回复
- `/resume` 自身会话 → 错误
- `/resume` 未知 target → 错误
- `/resume` 非 idle → 拒绝

### 7.5 Config 测试

扩展 `test/unit/config.test.ts`：
- `session_ttl_days` 解析 + 默认值 30

---

## 8. 文件清单

### 新建
无新文件——所有变更都在现有文件上。

### 修改
| 文件 | 变更 |
|---|---|
| `src/claude/session.ts` | `claudeSessionId` 字段、`session_id` 捕获、`onSessionIdCaptured` 回调、`resume` 透传、`SessionStatus` 扩展 |
| `src/claude/query-handle.ts` | `ClaudeQueryOptions` 新增 `resume?: string` |
| `src/claude/sdk-query.ts` | 转发 `resume` 到 SDK `query()` |
| `src/claude/session-manager.ts` | StateStore 集成、staleRecords map、防抖写入、启动加载、TTL 清理、崩溃恢复通知、`findSession`、`getAllSessions` |
| `src/commands/router.ts` | `sessions` 和 `resume` 解析 |
| `src/commands/dispatcher.ts` | `handleSessions`、`handleResume` 方法 |
| `src/config.ts` | `session_ttl_days` schema |
| `src/types.ts` | `AppConfig.persistence.sessionTtlDays` |
| `src/index.ts` | 传入 StateStore/FeishuClient 到 SessionManager、注册 SIGTERM/SIGINT 处理器 |
| `config.example.toml` | `session_ttl_days` 示例 |
| `test/unit/claude/session-state-machine.test.ts` | session_id 捕获 + resume 测试 |
| `test/unit/claude/session-manager.test.ts` | 持久化集成测试 |
| `test/unit/commands/router.test.ts` | 新命令解析测试 |
| `test/unit/commands/dispatcher.test.ts` | /sessions /resume 测试 |
| `test/unit/config.test.ts` | session_ttl_days 测试 |
