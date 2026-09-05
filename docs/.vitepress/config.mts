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
          {
            text: 'Storage',
            collapsed: false,
            items: [
              { text: 'Getting started', link: '/packages/storage/' },
              { text: 'Drivers', link: '/packages/storage/drivers' },
              { text: 'Configuration', link: '/packages/storage/configuration' },
              { text: 'Advanced', link: '/packages/storage/advanced' },
            ],
          },
          {
            text: 'Media',
            collapsed: false,
            items: [
              { text: 'Getting started', link: '/packages/media/' },
              { text: 'Orphan cleanup', link: '/packages/media/orphans' },
              { text: 'Reference', link: '/packages/media/reference' },
              { text: 'Testing', link: '/packages/media/testing' },
            ],
          },
          {
            text: 'Mailing',
            collapsed: false,
            items: [
              { text: 'Getting started', link: '/packages/mailing/' },
              { text: 'Queueing', link: '/packages/mailing/queue' },
              { text: 'Worker', link: '/packages/mailing/worker' },
              { text: 'Providers', link: '/packages/mailing/providers' },
              { text: 'Reference', link: '/packages/mailing/reference' },
              { text: 'Testing', link: '/packages/mailing/testing' },
            ],
          },
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
