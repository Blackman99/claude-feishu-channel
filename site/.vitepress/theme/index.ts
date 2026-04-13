import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import TerminalReplay from './components/TerminalReplay.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TerminalReplay', TerminalReplay)
  },
} satisfies Theme
