---
layout: home
hero:
  name: Claude Feishu Channel
  text: Claude and Codex, natively in Feishu / Lark
  tagline: A full coding-agent workflow in your Feishu group chat, with dual providers and staged context protection.
  image:
    src: /logo.svg
    alt: CFC Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: npm install -g claude-feishu-channel
      link: https://www.npmjs.com/package/claude-feishu-channel
features:
  - icon: 🤖
    title: Dual Providers
    details: Run either Claude or Codex, choose a global default, and switch per session with /provider.
  - icon: 🔐
    title: Permission Brokering
    details: Sensitive tool calls post interactive approval cards. You stay in control.
  - icon: 💾
    title: Session Persistence
    details: Survives process restarts and auto-resumes conversations where you left off.
  - icon: ⚡
    title: Queue & Interrupt
    details: Messages queue during generation. Use ! prefix to interrupt and redirect.
  - icon: 🧠
    title: Context Mitigation
    details: The bot warns early, compacts first, then starts a summarized fresh session before falling back to the 20MB hard reset path.
  - icon: 🎴
    title: Interactive Cards
    details: Streaming status, tool activity, thinking blocks — rich Feishu card UI.
  - icon: ⚙️
    title: Runtime Configuration
    details: /config set to tune behavior without restart, plus provider-aware status, model, and context commands.
---
