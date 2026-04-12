# E2E Hand-Testing Checklist

Run this checklist before each release. Each item requires a running
bot instance connected to a Feishu test group.

## Session Lifecycle

- [ ] **First message → auto session**: Send a plain text message to the bot.
      Expect: Claude responds normally, session created automatically.

- [ ] **Tool calls render**: Ask Claude to read or edit a file.
      Expect: Tool activity card shows tool name, params, and result.

- [ ] **Bash permission card → allow**: Ask Claude to run a shell command.
      Expect: Permission card appears. Click "允许". Command executes.

- [ ] **Permission timeout → auto-deny**: Trigger a permission card, wait
      5 minutes without clicking. Expect: Card shows "⏰ 已超时", Claude
      told the tool was denied.

- [ ] **Permission warn reminder**: Trigger a permission card, wait 4
      minutes. Expect: A "⏰ 60s" warning message appears.

- [ ] **Always-allow**: Click "始终允许" on a permission card. Expect:
      Subsequent calls of the same type proceed without a card.

- [ ] **TodoWrite history mode**: Ask Claude to create a task list.
      Expect: Each update sends a new card.

- [ ] **TodoWrite inplace mode**: Ask Claude to update a task list.
      Expect: The existing card is edited in place.

- [ ] **ExitPlanMode**: Ask Claude to plan something (requires plan mode).
      Expect: Plan card with approval button appears.

## Large Output

- [ ] **Long output → file upload**: Run `ls -R /` or a command with large
      output. Expect: Content delivered as a file attachment, not inline.

## Queue & Interrupt

- [ ] **Queue (generating + message)**: While Claude is generating, send
      another message. Expect: "📥 已加入队列 #1" reply.

- [ ] **Bang interrupt (`!`)**: While Claude is generating, send `! new request`.
      Expect: Current turn interrupted, new turn starts with "new request".

- [ ] **/stop during generating**: While Claude is generating, send `/stop`.
      Expect: Turn interrupted, "🛑 已停止" reply.

- [ ] **/stop during awaiting_permission**: Trigger a permission card,
      then send `/stop`. Expect: Permission denied, turn interrupted.

## Commands

- [ ] **/cd confirm card**: Send `/cd /tmp`. Expect: Confirm card appears.
      Click confirm. New session starts with cwd=/tmp.

- [ ] **/project alias**: Send `/project <alias>` (must be configured).
      Expect: Same as /cd with resolved path.

- [ ] **/new during generating**: While generating, send `/new`.
      Expect: Turn interrupted, new session started.

- [ ] **/mode switch**: Send `/mode acceptEdits`. Expect: Confirmation
      reply. Subsequent file edits auto-approved.

- [ ] **/model switch**: Send `/model claude-sonnet-4-6`. Expect:
      Confirmation reply. Next turn uses new model.

- [ ] **/status**: Send `/status`. Expect: Reply shows state, cwd, mode,
      model, turn count, tokens.

- [ ] **/config set --persist**: Send `/config set render.hide_thinking true --persist`.
      Expect: Confirmation with "已持久化". Check `config.toml` was updated.

## Persistence & Recovery

- [ ] **kill -9 → restart → resume**: Kill the bot process (`kill -9`),
      restart. Send a message. Expect: Session resumes (same Claude
      conversation), crash recovery notification sent.

## Access Control

- [ ] **Non-whitelisted user**: From an account not in `allowed_open_ids`,
      send a message. Expect: No response (ignore mode) or error (reject
      mode).

## Network Resilience

- [ ] **WS reconnect**: Simulate brief network drop. Expect: Gateway
      reconnects, messages during gap not lost, no duplicate processing.
