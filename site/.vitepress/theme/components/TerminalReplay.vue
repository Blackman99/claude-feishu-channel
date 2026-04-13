<template>
  <div ref="rootEl" class="terminal-replay-wrapper">
    <div class="terminal-window">
      <!-- Chrome bar -->
      <div class="terminal-chrome">
        <div class="terminal-dots">
          <span class="dot dot-red"></span>
          <span class="dot dot-yellow"></span>
          <span class="dot dot-green"></span>
        </div>
        <span class="terminal-title">Claude Feishu Channel</span>
        <span class="scene-label">{{ currentSceneLabel }}</span>
      </div>

      <!-- Chat area -->
      <div class="terminal-body" :class="{ 'scene-fade': fading }">
        <template v-for="(step, i) in currentSteps" :key="`${sceneIndex}-${i}`">
          <!-- User message -->
          <div
            v-if="step.type === 'user' && i <= visibleUpTo"
            class="chat-row chat-row-right step-visible"
          >
            <div class="bubble bubble-user">
              <span>{{ step.text }}</span>
              <span v-if="i === visibleUpTo" class="typing-cursor"></span>
            </div>
          </div>

          <!-- Status -->
          <div
            v-if="step.type === 'status' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <span class="status-text" :class="{ 'status-pulse': i === visibleUpTo }">
              {{ step.text }}
            </span>
          </div>

          <!-- Tool card -->
          <div
            v-if="step.type === 'tool' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="tool-card">
              <span class="tool-icon">{{ step.icon }}</span>
              <span class="tool-name">{{ step.name }}</span>
              <span class="tool-detail">{{ step.detail }}</span>
            </div>
          </div>

          <!-- Permission card -->
          <div
            v-if="step.type === 'permission' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="permission-card">
              <div class="permission-header">
                <span>&#x26A0;&#xFE0F; Allow this command?</span>
              </div>
              <div class="permission-info">
                <span class="tool-icon">🔧</span>
                <span class="tool-name">{{ step.tool }}</span>
                <span class="tool-detail">{{ step.command }}</span>
              </div>
              <div class="permission-buttons">
                <button
                  class="perm-btn perm-allow"
                  :class="{ 'perm-allow-active': isPermissionClicked(i) }"
                >Allow</button>
                <button class="perm-btn perm-deny">Deny</button>
              </div>
            </div>
          </div>

          <!-- System message (command response) -->
          <div
            v-if="step.type === 'system' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="system-card">
              <span>{{ step.text }}</span>
            </div>
          </div>

          <!-- Interrupt marker -->
          <div
            v-if="step.type === 'interrupt' && i <= visibleUpTo"
            class="chat-row chat-row-right step-visible"
          >
            <div class="bubble bubble-interrupt">
              <span class="interrupt-prefix">!</span>
              <span>{{ step.text }}</span>
            </div>
          </div>

          <!-- Stats card -->
          <div
            v-if="step.type === 'stats' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="stats-card">
              <div class="stats-row" v-for="(s, si) in step.items" :key="si">
                <span class="stats-label">{{ s.label }}</span>
                <span class="stats-value">{{ s.value }}</span>
              </div>
            </div>
          </div>

          <!-- Response -->
          <div
            v-if="step.type === 'response' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="bubble bubble-response">
              <span>🤖 {{ step.text }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- Scene indicators -->
      <div class="scene-dots">
        <span
          v-for="(_, si) in SCENES"
          :key="si"
          class="scene-dot"
          :class="{ 'scene-dot-active': si === sceneIndex }"
        ></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface StatsItem {
  label: string
  value: string
}

interface Step {
  type: 'user' | 'status' | 'tool' | 'permission' | 'permission-click' | 'response' | 'system' | 'interrupt' | 'stats'
  text?: string
  icon?: string
  name?: string
  detail?: string
  tool?: string
  command?: string
  items?: StatsItem[]
}

interface Scene {
  label: string
  steps: Step[]
}

const SCENES: Scene[] = [
  {
    label: '🤖 Full Agent Capabilities',
    steps: [
      { type: 'user', text: '帮我重构 src/utils.ts，提取公共方法' },
      { type: 'status', text: 'Thinking...' },
      { type: 'tool', icon: '📄', name: 'Read', detail: 'src/utils.ts' },
      { type: 'tool', icon: '🔍', name: 'Grep', detail: '"export function" src/' },
      { type: 'status', text: 'Planning refactor...' },
      { type: 'tool', icon: '✏️', name: 'Write', detail: 'src/utils/common.ts' },
      { type: 'tool', icon: '✏️', name: 'Edit', detail: 'src/utils.ts — remove extracted functions' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'pnpm test' },
      { type: 'response', text: '重构完成！提取了 3 个公共方法到 common.ts，所有 12 个测试通过。' },
    ],
  },
  {
    label: '🔐 Permission Brokering',
    steps: [
      { type: 'user', text: '清理构建产物并重新编译' },
      { type: 'status', text: 'Thinking...' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'rm -rf dist/' },
      { type: 'permission', tool: 'Bash', command: 'rm -rf dist/' },
      { type: 'permission-click' },
      { type: 'status', text: 'Running command...' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'pnpm build' },
      { type: 'response', text: '构建完成，共编译 42 个文件，输出到 dist/' },
    ],
  },
  {
    label: '⚡ Queue & Interrupt',
    steps: [
      { type: 'user', text: '分析一下项目的性能瓶颈' },
      { type: 'status', text: 'Analyzing...' },
      { type: 'tool', icon: '📄', name: 'Read', detail: 'src/index.ts' },
      { type: 'interrupt', text: '不用了，先帮我修复登录 bug' },
      { type: 'system', text: '⚡ 已中断当前任务，切换到新请求' },
      { type: 'tool', icon: '🔍', name: 'Grep', detail: '"login" src/' },
      { type: 'response', text: '找到了问题：src/auth.ts:42 的 token 过期判断逻辑有误...' },
    ],
  },
  {
    label: '⚙️ Runtime Configuration',
    steps: [
      { type: 'user', text: '/config set logging.level debug --persist' },
      { type: 'system', text: '✅ 配置已更新: logging.level = debug (已持久化)' },
      { type: 'user', text: '/mode acceptEdits' },
      { type: 'system', text: '✅ 权限模式已切换为 acceptEdits' },
      { type: 'user', text: '/status' },
      {
        type: 'stats',
        items: [
          { label: '状态', value: 'idle' },
          { label: '模型', value: 'claude-sonnet-4-20250514' },
          { label: '权限', value: 'acceptEdits' },
          { label: '轮次', value: '5' },
          { label: 'Tokens', value: '↓12.4k ↑3.2k' },
        ],
      },
    ],
  },
  {
    label: '💾 Session Persistence',
    steps: [
      { type: 'system', text: '⚠️ 上次 bot 异常重启，已恢复会话' },
      { type: 'user', text: '/sessions' },
      {
        type: 'stats',
        items: [
          { label: 'oc_abc123…', value: '~/projects/api  active' },
          { label: 'oc_def456…', value: '~/projects/web  stale' },
        ],
      },
      { type: 'user', text: '/resume oc_def456' },
      { type: 'system', text: '✅ 已恢复会话 oc_def456…, 工作目录: ~/projects/web' },
      { type: 'user', text: '继续上次的工作' },
      { type: 'response', text: '好的，我看到上次我们在优化数据库查询。让我继续...' },
    ],
  },
]

const sceneIndex = ref(0)
const visibleUpTo = ref(-1)
const fading = ref(false)
const rootEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let observer: IntersectionObserver | null = null
let isVisible = true

const currentSteps = computed(() => SCENES[sceneIndex.value].steps)
const currentSceneLabel = computed(() => SCENES[sceneIndex.value].label)

function isPermissionClicked(stepIndex: number): boolean {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'permission-click') {
      return visibleUpTo.value >= j
    }
  }
  return false
}

function getDelay(step: Step): number {
  switch (step.type) {
    case 'user': return 1000
    case 'status': return 600
    case 'tool': return 700
    case 'permission': return 900
    case 'permission-click': return 700
    case 'response': return 900
    case 'system': return 800
    case 'interrupt': return 900
    case 'stats': return 1000
    default: return 600
  }
}

function nextScene() {
  fading.value = true
  timer = setTimeout(() => {
    visibleUpTo.value = -1
    sceneIndex.value = (sceneIndex.value + 1) % SCENES.length
    fading.value = false
    timer = setTimeout(advance, 600)
  }, 400)
}

function advance() {
  if (!isVisible) {
    timer = setTimeout(advance, 500)
    return
  }
  const steps = currentSteps.value
  if (visibleUpTo.value >= steps.length - 1) {
    timer = setTimeout(nextScene, 2500)
    return
  }
  visibleUpTo.value++
  timer = setTimeout(advance, getDelay(steps[visibleUpTo.value]))
}

onMounted(() => {
  if (rootEl.value && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting
        })
      },
      { threshold: 0.1 },
    )
    observer.observe(rootEl.value)
  }
  timer = setTimeout(advance, 800)
})

onUnmounted(() => {
  if (timer) clearTimeout(timer)
  if (observer) observer.disconnect()
})
</script>

<style scoped>
.terminal-window {
  background: var(--term-bg, #1e1e2e);
  border-radius: 12px;
  border: 1px solid var(--term-border, #313244);
  overflow: hidden;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 14px;
  line-height: 1.5;
}

/* Chrome bar */
.terminal-chrome {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  border-bottom: 1px solid var(--term-border, #313244);
  background: var(--term-bg, #1e1e2e);
}

.terminal-dots {
  display: flex;
  gap: 6px;
  margin-right: 12px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-red { background: #f38ba8; }
.dot-yellow { background: #f9e2af; }
.dot-green { background: #a6e3a1; }

.terminal-title {
  color: #cdd6f4;
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
}

.scene-label {
  margin-left: auto;
  color: #cdd6f4;
  font-size: 11px;
  opacity: 0.6;
  white-space: nowrap;
}

/* Chat body */
.terminal-body {
  padding: 16px;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: opacity 0.35s ease;
}

.scene-fade {
  opacity: 0;
}

/* Scene indicator dots */
.scene-dots {
  display: flex;
  justify-content: center;
  gap: 6px;
  padding: 8px 0 12px;
}

.scene-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #45475a;
  transition: background 0.3s ease, transform 0.3s ease;
}

.scene-dot-active {
  background: #89b4fa;
  transform: scale(1.3);
}

/* Chat rows */
.chat-row {
  display: flex;
}

.chat-row-left {
  justify-content: flex-start;
}

.chat-row-right {
  justify-content: flex-end;
}

/* Step animation */
.step-visible {
  animation: stepIn 0.35s ease both;
}

@keyframes stepIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Bubbles */
.bubble {
  padding: 8px 14px;
  border-radius: 10px;
  max-width: 85%;
  word-break: break-word;
}

.bubble-user {
  background: #45475a;
  color: #cdd6f4;
}

.bubble-response {
  background: #313244;
  color: #cdd6f4;
}

.bubble-interrupt {
  background: #f38ba8;
  color: #1e1e2e;
}

.interrupt-prefix {
  font-weight: 700;
  margin-right: 4px;
}

/* Typing cursor */
.typing-cursor::after {
  content: '\2588';
  animation: blink 0.7s step-end infinite;
  margin-left: 2px;
  color: #cdd6f4;
}

@keyframes blink {
  50% { opacity: 0; }
}

/* Status text */
.status-text {
  color: #6c7086;
  font-size: 13px;
  padding-left: 4px;
}

.status-pulse {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Tool card */
.tool-card {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 8px 14px;
}

.tool-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.tool-name {
  color: #89b4fa;
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}

.tool-detail {
  color: #a6adc8;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* System message card */
.system-card {
  background: #313244;
  border-left: 3px solid #89b4fa;
  border-radius: 0 8px 8px 0;
  padding: 8px 14px;
  color: #cdd6f4;
  font-size: 13px;
}

/* Stats card */
.stats-card {
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 260px;
}

.stats-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.stats-label {
  color: #6c7086;
}

.stats-value {
  color: #cdd6f4;
  font-weight: 500;
}

/* Permission card */
.permission-card {
  background: #f9e2af;
  color: #1e1e2e;
  border-radius: 8px;
  padding: 12px 14px;
  max-width: 85%;
}

.permission-header {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 10px;
  opacity: 0.8;
}

.permission-info .tool-name {
  color: #1e1e2e;
}

.permission-info .tool-detail {
  color: #1e1e2e;
  opacity: 0.7;
}

.permission-buttons {
  display: flex;
  gap: 8px;
}

.perm-btn {
  border: none;
  border-radius: 6px;
  padding: 5px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
  transition: background 0.3s ease, color 0.3s ease;
  font-family: inherit;
}

.perm-allow {
  background: #a6e3a1;
  color: #1e1e2e;
}

.perm-allow-active {
  background: #40a02b;
  color: #ffffff;
}

.perm-deny {
  background: #6c7086;
  color: #cdd6f4;
}

/* Responsive */
@media (max-width: 480px) {
  .terminal-window {
    font-size: 12px;
  }

  .terminal-body {
    padding: 12px;
    min-height: 180px;
  }

  .bubble {
    max-width: 92%;
  }

  .stats-card {
    min-width: unset;
  }
}
</style>
