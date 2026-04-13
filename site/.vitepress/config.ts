import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Feishu Channel',
  description: 'Bridge Claude Code to Feishu group chat',
  base: '/claude-feishu-channel/',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/Blackman99/claude-feishu-channel' },
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
      { icon: 'github', link: 'https://github.com/Blackman99/claude-feishu-channel' },
    ],

    footer: {
      message: 'Built with VitePress',
    },
  },
})
