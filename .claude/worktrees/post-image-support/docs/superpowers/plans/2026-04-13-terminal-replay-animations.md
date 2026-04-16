# TerminalReplay 动画增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为首页 TerminalReplay.vue 的 Permission Broker 场景补全三段式点击动画，并为所有交互按钮添加 hover→click CSS keyframe 过渡 + 波纹效果。

**Architecture:** 只改一个文件 `site/.vitepress/theme/components/TerminalReplay.vue`。将 `isPermissionClicked()` 拆成 `isPermissionClicking()` / `isPermissionResolved()` 两个函数，实现与 Question Card 对称的三阶状态机（pending → clicking → resolved）。CSS 用 `@keyframes` 在 clicking 步骤期间自动播放 hover→click 视觉过渡；波纹通过 `::after` + `animation-delay` 实现。无需改其他文件。

**Tech Stack:** Vue 3 `<script setup>`, CSS `@keyframes`, VitePress

---

## 文件范围

| 文件 | 操作 |
|------|------|
| `site/.vitepress/theme/components/TerminalReplay.vue` | 修改（JS + Template + CSS 三部分） |

没有单元测试文件（纯视觉组件），验证方式是 `npm run docs:dev` 后目视检查首页动画。

---

### Task 1: 拆分 permission 状态函数并修复 `isPermissionClicked` 的 `>=` bug

**Files:**
- Modify: `site/.vitepress/theme/components/TerminalReplay.vue` — `<script setup>` 区块

当前 `isPermissionClicked()` 用 `>= j`，导致在 clicking 步骤当帧就立即折叠，没有中间高亮阶段。需要拆成两个函数，分别对应 clicking 和 resolved。

- [ ] **Step 1: 找到现有函数并理解结构**

在 `TerminalReplay.vue` 的 `<script setup>` 里找到：

```ts
function isPermissionClicked(stepIndex: number): boolean {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'permission-click') {
      return visibleUpTo.value >= j
    }
  }
  return false
}
```

- [ ] **Step 2: 替换为两个函数**

将上面整个函数删除，替换为：

```ts
// Returns true when the permission-click step is currently being "played"
// (visibleUpTo === j) — the clicking highlight phase.
function isPermissionClicking(stepIndex: number): boolean {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'permission-click') {
      return visibleUpTo.value === j
    }
  }
  return false
}

// Returns true once the permission-click step is fully past
// (visibleUpTo > j) — collapses to the resolved one-liner.
function isPermissionResolved(stepIndex: number): boolean {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'permission-click') {
      return visibleUpTo.value > j
    }
  }
  return false
}
```

- [ ] **Step 3: 调整 STEP_DELAYS**

找到：
```ts
const STEP_DELAYS: Record<string, number> = {
  ...
  'permission-click': 700,
  'question-click': 800,
  ...
}
```

改为：
```ts
const STEP_DELAYS: Record<string, number> = {
  user: 1000,
  status: 600,
  tool: 700,
  permission: 900,
  'permission-click': 1100,
  question: 1000,
  'question-click': 1100,
  response: 900,
  system: 800,
  interrupt: 900,
  stats: 1000,
}
```

（两个 click 步骤延长到 1100ms，容纳 hover 300ms + 按下 500ms + 保持 300ms）

- [ ] **Step 4: 启动 dev 服务器确认无报错**

```bash
cd /Users/zhaodongsheng/my-projects/claude-feishu-channel
npm run docs:dev 2>&1 | head -20
```

Expected: VitePress 启动成功，无 TS 编译错误。

- [ ] **Step 5: Commit**

```bash
git add site/.vitepress/theme/components/TerminalReplay.vue
git commit -m "refactor: split isPermissionClicked into clicking/resolved phases"
```

---

### Task 2: 更新 Template — Permission card 三段式渲染

**Files:**
- Modify: `site/.vitepress/theme/components/TerminalReplay.vue` — `<template>` 区块

- [ ] **Step 1: 找到现有 permission card 的条件渲染**

在 template 里找到：

```html
<!-- Resolved: compact one-liner, buttons gone -->
<div
  v-if="isPermissionClicked(i)"
  class="permission-card-resolved step-visible"
>
  ...
</div>
<!-- Pending: full card with buttons -->
<div v-else class="permission-card">
  ...
  <div class="permission-buttons">
    <button class="perm-btn perm-allow">✅ 允许</button>
    <button class="perm-btn perm-deny">❌ 拒绝</button>
  </div>
  ...
</div>
```

- [ ] **Step 2: 替换为三段式**

将上面两个 div（resolved + 完整卡片）全部替换为：

```html
<!-- Resolved: compact one-liner, buttons gone -->
<div
  v-if="isPermissionResolved(i)"
  class="permission-card-resolved step-visible"
>
  <span class="perm-resolved-icon">✅</span>
  <span class="perm-resolved-label">允许</span>
  <span class="perm-resolved-sep">·</span>
  <code class="perm-resolved-tool">{{ step.tool }}</code>
</div>
<!-- Clicking: full card, allow button in highlight+ripple state -->
<div v-else-if="isPermissionClicking(i)" class="permission-card">
  <div class="permission-header">
    <span>🔐 权限请求 · {{ step.tool }}</span>
  </div>
  <div class="permission-info">
    <span class="tool-icon">🔧</span>
    <span class="tool-name">{{ step.tool }}</span>
    <span class="tool-detail">{{ step.command }}</span>
  </div>
  <div class="permission-buttons">
    <button class="perm-btn perm-allow perm-allow--clicking">✅ 允许</button>
    <button class="perm-btn perm-deny">❌ 拒绝</button>
  </div>
  <div class="perm-hint">只有发起者可点击 · 5 分钟未响应自动拒绝</div>
</div>
<!-- Pending: full card, normal state -->
<div v-else class="permission-card">
  <div class="permission-header">
    <span>🔐 权限请求 · {{ step.tool }}</span>
  </div>
  <div class="permission-info">
    <span class="tool-icon">🔧</span>
    <span class="tool-name">{{ step.tool }}</span>
    <span class="tool-detail">{{ step.command }}</span>
  </div>
  <div class="permission-buttons">
    <button class="perm-btn perm-allow">✅ 允许</button>
    <button class="perm-btn perm-deny">❌ 拒绝</button>
  </div>
  <div class="perm-hint">只有发起者可点击 · 5 分钟未响应自动拒绝</div>
</div>
```

- [ ] **Step 3: 目视检查 — 切换到 Permission Brokering 场景**

打开 `http://localhost:5173`，切到 🔐 Permission Brokering 标签页，观察：
- Step 3（`permission` 步骤）出现完整卡片，按钮正常颜色 ✓
- Step 4（`permission-click` 步骤）卡片仍显示，允许按钮变色 ✓（CSS 还未加，暂时可能没变化）
- Step 5 之后卡片折叠为 "✅ 允许 · Bash" 一行 ✓

- [ ] **Step 4: Commit**

```bash
git add site/.vitepress/theme/components/TerminalReplay.vue
git commit -m "feat: add clicking intermediate state to permission card template"
```

---

### Task 3: 添加 Permission 允许按钮 hover→click CSS 动画 + 波纹

**Files:**
- Modify: `site/.vitepress/theme/components/TerminalReplay.vue` — `<style scoped>` 区块

- [ ] **Step 1: 找到现有 perm-btn 样式区域**

在 `<style scoped>` 里找到：

```css
.perm-allow {
  background: #a6e3a133;
  color: #a6e3a1;
  border: 1px solid #a6e3a155;
}

.perm-deny {
  ...
}
```

- [ ] **Step 2: 在 `.perm-deny` 之后插入 clicking 状态样式**

```css
/* Permission allow button — clicking phase */
/* Plays a hover→press keyframe automatically so the animation reads as
   "cursor moves in, button lights up, then click fires". The ripple ::after
   is delayed to sync with the press moment in the keyframe. */
.perm-allow--clicking {
  animation: perm-btn-hover-click 1100ms ease forwards;
}

@keyframes perm-btn-hover-click {
  0%   {
    background: #a6e3a133;
    color: #a6e3a1;
    border-color: #a6e3a155;
    transform: scale(1);
    box-shadow: none;
  }
  20%  {
    /* hover: subtle glow, slight scale */
    background: #a6e3a144;
    color: #a6e3a1;
    border-color: #a6e3a188;
    transform: scale(1.03);
    box-shadow: 0 0 0 3px #a6e3a122;
  }
  42%  {
    /* press: full fill, darker text, larger scale */
    background: #a6e3a1;
    color: #1e2e25;
    border-color: #a6e3a1;
    transform: scale(1.05);
    box-shadow: 0 0 0 4px #a6e3a133;
  }
  100% {
    /* hold pressed until resolved transition */
    background: #a6e3a1;
    color: #1e2e25;
    border-color: #a6e3a1;
    transform: scale(1.05);
    box-shadow: 0 0 0 4px #a6e3a133;
  }
}

/* Ripple — fires when the "press" keyframe hits (~42% × 1100ms ≈ 460ms) */
.perm-allow--clicking::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.45);
  animation: perm-ripple 500ms ease-out forwards;
  animation-delay: 400ms;
  pointer-events: none;
}

@keyframes perm-ripple {
  0%   { width: 0;    height: 0;    opacity: 0.5; }
  100% { width: 220%; height: 220%; opacity: 0; }
}
```

> Note: `.perm-btn` already has `position: relative; overflow: hidden` — confirm this. If not, add it.

- [ ] **Step 2b: 确认 .perm-btn 有 position: relative + overflow: hidden**

找到 `.perm-btn` 的 CSS 定义：

```css
.perm-btn {
  border: none;
  border-radius: 6px;
  padding: 5px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
  font-family: inherit;
  flex: 1;
}
```

如果没有 `position` 和 `overflow`，将其改为：

```css
.perm-btn {
  position: relative;
  overflow: hidden;
  border: none;
  border-radius: 6px;
  padding: 5px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
  font-family: inherit;
  flex: 1;
}
```

- [ ] **Step 3: 目视验证 Permission Brokering 场景**

切到 🔐 Permission Brokering：
- `permission` 步骤：普通绿色允许按钮 ✓
- `permission-click` 步骤：按钮从浅绿 → 鼠标悬停（scale + glow）→ 按下（深绿填充）→ 白色波纹扩散 ✓
- 之后：折叠为 resolved 一行 ✓

- [ ] **Step 4: Commit**

```bash
git add site/.vitepress/theme/components/TerminalReplay.vue
git commit -m "feat: add hover→click keyframe and ripple to permission allow button"
```

---

### Task 4: Question 选项按钮补 hover 起始帧

**Files:**
- Modify: `site/.vitepress/theme/components/TerminalReplay.vue` — `<style scoped>`

当前 `q-opt-btn--selected` 直接跳到 selected（蓝色），没有 hover 过渡阶段。加上与 permission 对称的 keyframe。

- [ ] **Step 1: 找到现有 q-opt-btn--selected 样式**

```css
.q-opt-btn--selected {
  background: #89b4fa;
  color: #1e1e2e;
  border-color: #89b4fa;
  transform: scale(1.04);
}
```

- [ ] **Step 2: 替换为带 hover 起始帧的 keyframe 版本**

```css
.q-opt-btn--selected {
  animation: q-btn-hover-click 1100ms ease forwards;
}

@keyframes q-btn-hover-click {
  0%   {
    background: #89b4fa1a;
    color: #89b4fa;
    border-color: #89b4fa44;
    transform: scale(1);
  }
  20%  {
    /* hover */
    background: #89b4fa33;
    color: #89b4fa;
    border-color: #89b4fa88;
    transform: scale(1.03);
  }
  42%  {
    /* press */
    background: #89b4fa;
    color: #1e1e2e;
    border-color: #89b4fa;
    transform: scale(1.05);
  }
  100% {
    background: #89b4fa;
    color: #1e1e2e;
    border-color: #89b4fa;
    transform: scale(1.05);
  }
}
```

- [ ] **Step 3: 更新 q-opt-btn--selected::after 的 animation-delay**

找到现有的波纹：

```css
.q-opt-btn--selected::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.45);
  animation: q-ripple 500ms ease-out forwards;
}
```

加上 delay（对齐 press 时刻）：

```css
.q-opt-btn--selected::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.45);
  animation: q-ripple 500ms ease-out forwards;
  animation-delay: 400ms;
}
```

- [ ] **Step 4: 目视验证 Interactive Q&A 场景**

切到 🙋 Interactive Q&A：
- `question` 步骤：三个蓝色选项按钮 ✓
- `question-click` 步骤：Vue 按钮从初始态 → hover（浅蓝 + scale）→ press（深蓝填充）→ 白色波纹 ✓
- 之后：折叠为 "❓ Q1 → Vue" 一行 ✓

- [ ] **Step 5: Commit**

```bash
git add site/.vitepress/theme/components/TerminalReplay.vue
git commit -m "feat: add hover→click keyframe to question option button"
```

---

### Task 5: 全场景回归 + 发布

**Files:**
- Read-only verification

- [ ] **Step 1: 走一遍全部 6 个场景**

在浏览器 `http://localhost:5173` 依次点击每个 tab，确认：

| 场景 | 检查点 |
|------|--------|
| 🤖 Agent Capabilities | 无 permission / question 步骤，正常工具卡片渲染 ✓ |
| 🔐 Permission Brokering | pending → clicking（hover→press 动画 + 波纹）→ resolved ✓ |
| 🙋 Interactive Q&A | pending → clicking（hover→press 动画 + 波纹）→ resolved ✓ |
| ⚡ Queue & Interrupt | 无 click 步骤，正常渲染 ✓ |
| ⚙️ Runtime Config | 无 click 步骤，正常渲染 ✓ |
| 💾 Session Persistence | 无 click 步骤，正常渲染 ✓ |

- [ ] **Step 2: 运行 typecheck 确认无 TS 错误**

```bash
npm run typecheck 2>&1
```

Expected: 无报错输出（exit 0）。

- [ ] **Step 3: 构建文档站确认无构建错误**

```bash
npm run docs:build 2>&1 | tail -10
```

Expected: `build complete` 类似输出，无 error。

- [ ] **Step 4: 推送到远端**

本次改动仅在 `site/`（VitePress 文档站），不改 `src/` 包代码，无需 npm 版本升级。

```bash
git push origin main
```

Expected: push 成功，GitHub Actions 若有 pages 部署 workflow 则自动更新文档站。
