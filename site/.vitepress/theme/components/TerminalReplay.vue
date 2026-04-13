<template>
  <div ref="rootEl" class="terminal-replay-wrapper">
    <!-- Scene tab bar -->
    <div class="scene-tabs">
      <button
        v-for="(scene, si) in SCENES"
        :key="si"
        class="scene-tab"
        :class="{ 'scene-tab-active': si === sceneIndex }"
        @click="goToScene(si)"
      >
        <span class="scene-tab-icon">{{ scene.icon }}</span>
        <span class="scene-tab-text">{{ scene.title }}</span>
        <!-- Auto-play progress bar -->
        <span
          v-if="si === sceneIndex"
          class="scene-tab-progress"
          :style="{ animationDuration: sceneDurationMs + 'ms', animationPlayState: autoPlaying ? 'running' : 'paused' }"
        ></span>
      </button>
    </div>

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

      <!-- Prev / Next arrows -->
      <button class="nav-arrow nav-arrow-left" @click="prevScene" aria-label="Previous">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="nav-arrow nav-arrow-right" @click="nextSceneManual" aria-label="Next">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>

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
              <span v-if="i === visibleUpTo && autoPlaying" class="typing-cursor"></span>
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
            <!-- Resolved: compact one-liner, buttons gone -->
            <div
              v-if="isPermissionClicked(i)"
              class="permission-card-resolved step-visible"
            >
              <span class="perm-resolved-icon">✅</span>
              <span class="perm-resolved-label">允许</span>
              <span class="perm-resolved-sep">·</span>
              <code class="perm-resolved-tool">{{ step.tool }}</code>
            </div>
            <!-- Pending: full card with buttons -->
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
          </div>

          <!-- Question card -->
          <div
            v-if="step.type === 'question' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <!-- Resolved: compact answer line, buttons gone -->
            <div
              v-if="questionAnswer(i) !== null"
              class="question-card-resolved step-visible"
            >
              <span class="q-resolved-q">❓ Q1</span>
              <span class="q-resolved-arrow">→</span>
              <span class="q-resolved-answer">{{ questionAnswer(i) }}</span>
            </div>
            <!-- Pending / clicking: question with option buttons -->
            <div v-else class="question-card">
              <div class="question-header">🙋 问题</div>
              <div class="question-text">{{ step.text }}</div>
              <div class="question-options">
                <button
                  v-for="(opt, oi) in step.options"
                  :key="oi"
                  class="q-opt-btn"
                  :class="{ 'q-opt-btn--selected': questionClickingOption(i) === oi }"
                >{{ opt }}</button>
              </div>
            </div>
          </div>

          <!-- System message -->
          <div
            v-if="step.type === 'system' && i <= visibleUpTo"
            class="chat-row chat-row-left step-visible"
          >
            <div class="system-card">
              <span>{{ step.text }}</span>
            </div>
          </div>

          <!-- Interrupt -->
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
  type: 'user' | 'status' | 'tool' | 'permission' | 'permission-click' | 'question' | 'question-click' | 'response' | 'system' | 'interrupt' | 'stats'
  text?: string
  icon?: string
  name?: string
  detail?: string
  tool?: string
  command?: string
  items?: StatsItem[]
  // question card
  options?: string[]
  optionIndex?: number
}

interface Scene {
  icon: string
  title: string
  steps: Step[]
}

const SCENES: Scene[] = [
  {
    icon: '🤖',
    title: 'Agent Capabilities',
    steps: [
      { type: 'user', text: 'Refactor src/utils.ts and extract shared helpers' },
      { type: 'status', text: 'Thinking...' },
      { type: 'tool', icon: '📄', name: 'Read', detail: 'src/utils.ts' },
      { type: 'tool', icon: '🔍', name: 'Grep', detail: '"export function" src/' },
      { type: 'status', text: 'Planning refactor...' },
      { type: 'tool', icon: '✏️', name: 'Write', detail: 'src/utils/common.ts' },
      { type: 'tool', icon: '✏️', name: 'Edit', detail: 'src/utils.ts — remove extracted functions' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'pnpm test' },
      { type: 'response', text: 'Done! Extracted 3 helpers into common.ts. All 12 tests pass.' },
    ],
  },
  {
    icon: '🔐',
    title: 'Permission Brokering',
    steps: [
      { type: 'user', text: 'Clean build artifacts and rebuild' },
      { type: 'status', text: 'Thinking...' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'rm -rf dist/' },
      { type: 'permission', tool: 'Bash', command: 'rm -rf dist/' },
      { type: 'permission-click' },
      { type: 'status', text: 'Running command...' },
      { type: 'tool', icon: '🔧', name: 'Bash', detail: 'pnpm build' },
      { type: 'response', text: 'Build complete — 42 files compiled, output in dist/' },
    ],
  },
  {
    icon: '🙋',
    title: 'Interactive Q&A',
    steps: [
      { type: 'user', text: 'Build a user login page for me' },
      { type: 'status', text: 'Thinking...' },
      {
        type: 'question',
        text: 'Which frontend framework?',
        options: ['React', 'Vue', 'Vanilla HTML'],
      },
      { type: 'question-click', optionIndex: 1 },
      { type: 'status', text: 'Generating...' },
      { type: 'tool', icon: '✏️', name: 'Write', detail: 'src/views/Login.vue' },
      { type: 'tool', icon: '✏️', name: 'Edit', detail: 'src/router/index.ts' },
      { type: 'response', text: 'Login page created (Vue). Includes form validation, error messages, and remember me.' },
    ],
  },
  {
    icon: '⚡',
    title: 'Queue & Interrupt',
    steps: [
      { type: 'user', text: 'Analyze the performance bottlenecks in this project' },
      { type: 'status', text: 'Analyzing...' },
      { type: 'tool', icon: '📄', name: 'Read', detail: 'src/index.ts' },
      { type: 'interrupt', text: '! Stop — fix the login bug first' },
      { type: 'system', text: '⚡ Task interrupted, switching to new request' },
      { type: 'tool', icon: '🔍', name: 'Grep', detail: '"login" src/' },
      { type: 'response', text: 'Found it: src/auth.ts:42 has a wrong token expiry check…' },
    ],
  },
  {
    icon: '⚙️',
    title: 'Runtime Config',
    steps: [
      { type: 'user', text: '/config set logging.level debug --persist' },
      { type: 'system', text: '✅ Config updated: logging.level = debug (persisted)' },
      { type: 'user', text: '/mode acceptEdits' },
      { type: 'system', text: '✅ Permission mode switched to acceptEdits' },
      { type: 'user', text: '/status' },
      {
        type: 'stats',
        items: [
          { label: 'Status', value: 'idle' },
          { label: 'Model', value: 'claude-sonnet-4-20250514' },
          { label: 'Mode', value: 'acceptEdits' },
          { label: 'Turns', value: '5' },
          { label: 'Tokens', value: '↓12.4k ↑3.2k' },
        ],
      },
    ],
  },
  {
    icon: '💾',
    title: 'Session Persistence',
    steps: [
      { type: 'system', text: '⚠️ Bot restarted — previous session restored' },
      { type: 'user', text: '/sessions' },
      {
        type: 'stats',
        items: [
          { label: 'oc_abc123…', value: '~/projects/api  active' },
          { label: 'oc_def456…', value: '~/projects/web  stale' },
        ],
      },
      { type: 'user', text: '/resume oc_def456' },
      { type: 'system', text: '✅ Session oc_def456… resumed, cwd: ~/projects/web' },
      { type: 'user', text: 'Continue where we left off' },
      { type: 'response', text: 'Sure — last time we were optimizing DB queries. Picking up from there…' },
    ],
  },
]

const STEP_DELAYS: Record<string, number> = {
  user: 1000,
  status: 600,
  tool: 700,
  permission: 900,
  'permission-click': 700,
  question: 1000,
  'question-click': 800,
  response: 900,
  system: 800,
  interrupt: 900,
  stats: 1000,
}

const sceneIndex = ref(0)
const visibleUpTo = ref(-1)
const fading = ref(false)
const autoPlaying = ref(true)
const rootEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let observer: IntersectionObserver | null = null
let isVisible = true

const currentSteps = computed(() => SCENES[sceneIndex.value].steps)

// Total animation duration for the progress bar
const sceneDurationMs = computed(() => {
  let total = 0
  for (const step of currentSteps.value) {
    total += STEP_DELAYS[step.type] ?? 600
  }
  return total + 2500 // + end pause
})

function isPermissionClicked(stepIndex: number): boolean {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'permission-click') {
      return visibleUpTo.value >= j
    }
  }
  return false
}

// Returns the selected option label when question-click has been reached,
// or null while still pending.
function questionAnswer(stepIndex: number): string | null {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'question-click') {
      // Only collapse (resolved) when we are *past* the click step,
      // so the "clicking" highlight phase is visible while visibleUpTo === j.
      if (visibleUpTo.value > j) {
        const optIdx = steps[j].optionIndex ?? 0
        return steps[stepIndex].options?.[optIdx] ?? null
      }
      return null
    }
  }
  return null
}

// Returns the optionIndex being "clicked" during the question-click step,
// or null when outside that window (pending or already resolved).
function questionClickingOption(stepIndex: number): number | null {
  const steps = currentSteps.value
  for (let j = stepIndex + 1; j < steps.length; j++) {
    if (steps[j].type === 'question-click') {
      if (visibleUpTo.value === j) {
        return steps[j].optionIndex ?? 0
      }
      return null
    }
  }
  return null
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function switchScene(index: number) {
  clearTimer()
  fading.value = true
  timer = setTimeout(() => {
    visibleUpTo.value = -1
    sceneIndex.value = index
    fading.value = false
    timer = setTimeout(advance, 500)
  }, 350)
}

function goToScene(index: number) {
  if (index === sceneIndex.value && visibleUpTo.value >= currentSteps.value.length - 1) {
    // Clicked the same completed scene — replay it
    switchScene(index)
    return
  }
  if (index === sceneIndex.value) return
  autoPlaying.value = true
  switchScene(index)
}

function prevScene() {
  const next = (sceneIndex.value - 1 + SCENES.length) % SCENES.length
  autoPlaying.value = true
  switchScene(next)
}

function nextSceneManual() {
  const next = (sceneIndex.value + 1) % SCENES.length
  autoPlaying.value = true
  switchScene(next)
}

function nextSceneAuto() {
  const next = (sceneIndex.value + 1) % SCENES.length
  switchScene(next)
}

function advance() {
  if (!isVisible) {
    timer = setTimeout(advance, 500)
    return
  }
  const steps = currentSteps.value
  if (visibleUpTo.value >= steps.length - 1) {
    if (autoPlaying.value) {
      timer = setTimeout(nextSceneAuto, 2500)
    }
    return
  }
  visibleUpTo.value++
  const delay = STEP_DELAYS[steps[visibleUpTo.value].type] ?? 600
  timer = setTimeout(advance, delay)
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
  clearTimer()
  if (observer) observer.disconnect()
})
</script>

<style scoped>
/* Scene tab bar */
.scene-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding: 0 2px;
}

.scene-tabs::-webkit-scrollbar {
  display: none;
}

.scene-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: none;
  background: #313244;
  color: #6c7086;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border-radius: 10px 10px 0 0;
  white-space: nowrap;
  transition: background 0.2s, color 0.2s;
  overflow: hidden;
  flex: 1;
  justify-content: center;
}

.scene-tab:hover {
  background: #45475a;
  color: #cdd6f4;
}

.scene-tab-active {
  background: var(--term-bg, #1e1e2e);
  color: #cdd6f4;
}

.scene-tab-icon {
  font-size: 14px;
}

.scene-tab-text {
  font-size: 12px;
}

/* Progress bar under active tab */
.scene-tab-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: #89b4fa;
  animation: tabProgress linear forwards;
  width: 0;
}

@keyframes tabProgress {
  from { width: 0; }
  to { width: 100%; }
}

/* Terminal window */
.terminal-window {
  position: relative;
  background: var(--term-bg, #1e1e2e);
  border-radius: 0 0 12px 12px;
  border: 1px solid var(--term-border, #313244);
  border-top: none;
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

/* Navigation arrows */
.nav-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #45475a;
  background: #313244;
  color: #6c7086;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
  padding: 0;
}

.nav-arrow:hover {
  background: #45475a;
  color: #cdd6f4;
  border-color: #6c7086;
}

.nav-arrow-left {
  left: 8px;
}

.nav-arrow-right {
  right: 8px;
}

/* Chat body */
.terminal-body {
  padding: 16px 48px;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: opacity 0.3s ease;
}

.scene-fade {
  opacity: 0;
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

/* Question card — pending state */
.question-card {
  background: #1e2a3a;
  border: 1px solid #89b4fa44;
  border-top: 3px solid #89b4fa;
  border-radius: 8px;
  padding: 12px 14px;
  max-width: 85%;
}

.question-header {
  font-weight: 600;
  font-size: 13px;
  color: #89b4fa;
  margin-bottom: 6px;
}

.question-text {
  font-size: 13px;
  color: #cdd6f4;
  margin-bottom: 10px;
}

.question-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.q-opt-btn {
  position: relative;
  overflow: hidden;
  border: 1px solid #89b4fa44;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: default;
  font-family: inherit;
  background: #89b4fa1a;
  color: #89b4fa;
  transition: background 150ms ease, color 150ms ease, border-color 150ms ease, transform 150ms ease;
}

.q-opt-btn--selected {
  background: #89b4fa;
  color: #1e1e2e;
  border-color: #89b4fa;
  transform: scale(1.04);
}

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

@keyframes q-ripple {
  0%   { width: 0;    height: 0;    opacity: 0.5; }
  100% { width: 220%; height: 220%; opacity: 0; }
}

/* Question card — resolved state */
.question-card-resolved {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #1e2535;
  border: 1px solid #89b4fa33;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  animation: stepIn 0.35s ease both;
}

.q-resolved-q {
  color: #6c7086;
  font-size: 12px;
}

.q-resolved-arrow {
  color: #45475a;
  font-size: 12px;
}

.q-resolved-answer {
  color: #89b4fa;
  font-weight: 600;
}

/* Permission card — pending state */
.permission-card {
  background: #2a2520;
  border: 1px solid #f9e2af44;
  border-top: 3px solid #f9e2af;
  border-radius: 8px;
  padding: 12px 14px;
  max-width: 85%;
}

.permission-header {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
  color: #f9e2af;
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 10px;
}

.permission-info .tool-name {
  color: #89b4fa;
}

.permission-info .tool-detail {
  color: #a6adc8;
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
  font-family: inherit;
  flex: 1;
}

.perm-allow {
  background: #a6e3a133;
  color: #a6e3a1;
  border: 1px solid #a6e3a155;
}

.perm-deny {
  background: #f38ba822;
  color: #f38ba8;
  border: 1px solid #f38ba844;
}

.perm-hint {
  font-size: 11px;
  color: #585b70;
  margin-top: 8px;
}

/* Permission card — resolved state (after click) */
.permission-card-resolved {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #1e3a28;
  border: 1px solid #a6e3a133;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  animation: stepIn 0.35s ease both;
}

.perm-resolved-icon {
  font-size: 13px;
}

.perm-resolved-label {
  color: #a6e3a1;
  font-weight: 600;
}

.perm-resolved-sep {
  color: #585b70;
}

.perm-resolved-tool {
  color: #89b4fa;
  background: #313244;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

/* Responsive */
@media (max-width: 640px) {
  .terminal-window {
    font-size: 12px;
  }

  .terminal-body {
    padding: 12px 40px;
    min-height: 180px;
  }

  .bubble {
    max-width: 92%;
  }

  .stats-card {
    min-width: unset;
  }

  .scene-tab {
    padding: 8px 10px;
  }

  .scene-tab-text {
    font-size: 11px;
  }

  .nav-arrow {
    width: 26px;
    height: 26px;
  }

  .nav-arrow-left { left: 4px; }
  .nav-arrow-right { right: 4px; }
}

@media (max-width: 480px) {
  .scene-tab-text {
    display: none;
  }

  .scene-tab {
    padding: 8px 12px;
    flex: unset;
  }

  .scene-tabs {
    justify-content: center;
  }

  .terminal-body {
    padding: 10px 36px;
  }
}
</style>
