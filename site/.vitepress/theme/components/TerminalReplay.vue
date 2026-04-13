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
      </div>

      <!-- Chat area -->
      <div class="terminal-body">
        <template v-for="(step, i) in STEPS" :key="i">
          <!-- User message -->
          <div
            v-if="step.type === 'user' && i <= visibleUpTo"
            class="chat-row chat-row-right"
            :class="i <= visibleUpTo ? 'step-visible' : 'step-enter'"
          >
            <div class="bubble bubble-user">
              <span>{{ step.text }}</span>
              <span v-if="i === visibleUpTo" class="typing-cursor"></span>
            </div>
          </div>

          <!-- Status -->
          <div
            v-if="step.type === 'status' && i <= visibleUpTo"
            class="chat-row chat-row-left"
            :class="i <= visibleUpTo ? 'step-visible' : 'step-enter'"
          >
            <span class="status-text" :class="{ 'status-pulse': i === visibleUpTo }">{{ step.text }}</span>
          </div>

          <!-- Tool card -->
          <div
            v-if="step.type === 'tool' && i <= visibleUpTo"
            class="chat-row chat-row-left"
            :class="i <= visibleUpTo ? 'step-visible' : 'step-enter'"
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
            class="chat-row chat-row-left"
            :class="i <= visibleUpTo ? 'step-visible' : 'step-enter'"
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
                  :class="{ 'perm-allow-active': permissionClicked }"
                >Allow</button>
                <button class="perm-btn perm-deny">Deny</button>
              </div>
            </div>
          </div>

          <!-- Permission click (no visual element, handled by permissionClicked state) -->

          <!-- Response -->
          <div
            v-if="step.type === 'response' && i <= visibleUpTo"
            class="chat-row chat-row-left"
            :class="i <= visibleUpTo ? 'step-visible' : 'step-enter'"
          >
            <div class="bubble bubble-response">
              <span>🤖 {{ step.text }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

interface Step {
  type: 'user' | 'status' | 'tool' | 'permission' | 'permission-click' | 'response'
  text?: string
  icon?: string
  name?: string
  detail?: string
  tool?: string
  command?: string
}

const STEPS: Step[] = [
  { type: 'user', text: '帮我看一下 src/config.ts 的结构' },
  { type: 'status', text: 'Thinking...' },
  { type: 'tool', icon: '📄', name: 'Read', detail: 'src/config.ts' },
  { type: 'status', text: 'Reading file...' },
  { type: 'tool', icon: '🔧', name: 'Bash', detail: 'wc -l src/config.ts' },
  { type: 'permission', tool: 'Bash', command: 'wc -l src/config.ts' },
  { type: 'permission-click' },
  { type: 'status', text: 'Running command...' },
  { type: 'response', text: 'config.ts 导出了一个 loadConfig 函数，负责读取 TOML 配置文件并用 Zod schema 验证。主要类型是 AppConfig，包含 feishu、claude、render 等配置段。' },
]

const visibleUpTo = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let observer: IntersectionObserver | null = null
let isVisible = true

const permissionClicked = computed(() => {
  // The permission-click step is at index 6
  const clickIndex = STEPS.findIndex(s => s.type === 'permission-click')
  return visibleUpTo.value >= clickIndex
})

function getDelay(step: Step): number {
  switch (step.type) {
    case 'user': return 1200
    case 'status': return 600
    case 'tool': return 800
    case 'permission': return 1000
    case 'permission-click': return 800
    case 'response': return 1000
    default: return 600
  }
}

function advance() {
  if (!isVisible) {
    timer = setTimeout(advance, 500)
    return
  }
  if (visibleUpTo.value >= STEPS.length - 1) {
    timer = setTimeout(() => {
      visibleUpTo.value = -1
      timer = setTimeout(advance, 500)
    }, 3000)
    return
  }
  visibleUpTo.value++
  timer = setTimeout(advance, getDelay(STEPS[visibleUpTo.value]))
}

onMounted(() => {
  if (rootEl.value && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting
        })
      },
      { threshold: 0.1 }
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

/* Chat body */
.terminal-body {
  padding: 16px;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.step-enter {
  opacity: 0;
  transform: translateY(12px);
}

.step-visible {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.35s ease, transform 0.35s ease;
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
  }

  .bubble {
    max-width: 92%;
  }
}
</style>
