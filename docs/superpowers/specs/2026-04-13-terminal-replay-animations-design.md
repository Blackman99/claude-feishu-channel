# TerminalReplay 动画增强设计

**日期**: 2026-04-13  
**文件**: `site/.vitepress/theme/components/TerminalReplay.vue`

---

## 目标

1. **Permission Broker 场景补全动画** — 目前 `permission-click` 步骤直接折叠卡片，缺少中间"点击中"的高亮阶段，与 Question Card 的三段式不对称。
2. **hover → click 视觉过渡** — 在 `permission-click` 和 `question-click` 步骤期间，用 CSS keyframe 自动模拟"鼠标移入悬停 → 按下"的视觉节奏（不加真实假光标）。
3. **点击波纹** — Permission 允许按钮同样获得 `::after` 白色扩散波纹，与 Question 选项按钮对齐。

---

## 三段式状态机（两张卡片统一）

| 阶段 | 判断条件 | 渲染 |
|------|----------|------|
| pending | `visibleUpTo < j`（click 步的 index） | 完整卡片，按钮正常态 |
| clicking | `visibleUpTo === j` | 完整卡片，目标按钮播放 hover→click keyframe + 波纹 |
| resolved | `visibleUpTo > j` | 折叠为一行 resolved 卡片 |

> Question Card 已有 clicking / resolved 逻辑，只需将 `isPermissionClicked()` 拆成 `isPermissionClicking()` + `isPermissionResolved()` 两个函数，将原来的 `>= j` 改为 `> j`。

---

## CSS 动画设计

### `perm-allow--clicking`（Permission 允许按钮）

```
0%   → hover 态：背景浅绿，scale(1.03)
30%  → click 态：背景实绿，文字深色，scale(1.05)
100% → 保持 click 态
```

波纹 `::after` 延迟 200ms（对齐 click 态开始时刻），扩散 500ms，与 Question 的波纹逻辑一致。

### `q-opt-btn--selected` 增强（Question 选项按钮）

当前：直接跳到 selected（蓝色填充）。  
新增：keyframe 同样先经过 hover 态（200ms），再切换到 click 态，让过渡更自然。

### STEP_DELAYS 调整

- `permission-click`: 700ms → **1000ms**（容纳 hover 300ms + click 700ms）
- `question-click`: 800ms → **1000ms**（统一节奏）

---

## 实现范围（只改 TerminalReplay.vue）

### JS 变更（`<script setup>`）

1. 删除 `isPermissionClicked(stepIndex)`  
2. 新增 `isPermissionClicking(stepIndex)` — 返回 `visibleUpTo === j`  
3. 新增 `isPermissionResolved(stepIndex)` — 返回 `visibleUpTo > j`  
4. 调整 `STEP_DELAYS['permission-click']` = 1000，`STEP_DELAYS['question-click']` = 1000

### Template 变更

Permission card 的 `v-if="isPermissionClicked(i)"` 拆成：
- `v-if="isPermissionResolved(i)"` → resolved 一行
- `v-else-if="isPermissionClicking(i)"` → 完整卡片，允许按钮加 `perm-allow--clicking` 类
- `v-else` → 完整卡片，正常态

### CSS 变更

1. 新增 `@keyframes perm-btn-hover-click`（hover→click 过渡）
2. `.perm-allow--clicking` 使用该 keyframe（时长 1000ms）
3. `.perm-allow--clicking::after` — 波纹，`animation-delay: 250ms`
4. 更新 `.q-opt-btn--selected` — 补 hover 起始帧，让过渡更顺滑（可选，低优先级）

---

## 不改动内容

- SCENES 数据不变（`permission-click` 步骤已存在）
- Question Card 的三段逻辑（`questionAnswer` / `questionClickingOption`）不变
- 其他场景、其他卡片类型不涉及
