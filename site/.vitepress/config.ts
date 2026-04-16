import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Agent Feishu Channel',
  description: 'Bridge Claude Code or Codex to Feishu group chat',
  base: '/agent-feishu-channel/',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-feishu-channel/favicon.svg' }],
  ],

  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo.svg' },

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'npm', link: 'https://www.npmjs.com/package/agent-feishu-channel' },
      { text: 'GitHub', link: 'https://github.com/Blackman99/agent-feishu-channel' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Architecture', link: '/guide/architecture' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Blackman99/agent-feishu-channel' },
    ],

    footer: {
      message: 'Built with VitePress',
    },
  },
})
