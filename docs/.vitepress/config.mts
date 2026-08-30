import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'GoMakeNow',
  description: 'Documentation for GoMakeNow, the Go boilerplate',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    search: {
      provider: 'local',
    },
    outline: { level: [2, 3] },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Packages', link: '/packages/' },
      { text: 'Cookbook', link: '/cookbook/' },
      { text: 'GitHub', link: 'https://github.com/gomakenow' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Migrations', link: '/guide/migrations' },
        ],
      },
      {
        text: 'Packages',
        items: [
          { text: 'Overview', link: '/packages/' },
          {
            text: 'Query',
            collapsed: false,
            items: [
              { text: 'Getting started', link: '/packages/query/' },
              { text: 'Schema reference', link: '/packages/query/schema' },
              { text: 'URL parameters', link: '/packages/query/query-string' },
              { text: 'Advanced', link: '/packages/query/advanced' },
            ],
          },
          { text: 'storage', link: '/packages/storage' },
          { text: 'mailing', link: '/packages/mailing' },
          { text: 'payment', link: '/packages/payment' },
          { text: 'discount', link: '/packages/discount' },
        ],
      },
      {
        text: 'Cookbook',
        items: [
          { text: 'Overview', link: '/cookbook/' },
          { text: 'New admin table', link: '/cookbook/new-admin-table' },
          { text: 'New payment provider', link: '/cookbook/new-payment-provider' },
          { text: 'New mail provider', link: '/cookbook/new-mail-provider' },
          { text: 'New storage driver', link: '/cookbook/new-storage-driver' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/gomakenow' },
    ],
  },
})
