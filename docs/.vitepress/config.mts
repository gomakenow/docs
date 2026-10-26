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
            text: 'Auth',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/auth/' },
              { text: 'Middleware', link: '/packages/auth/middleware' },
              { text: 'Sessions', link: '/packages/auth/sessions' },
              { text: 'Email links', link: '/packages/auth/credentials' },
              { text: '2FA and OAuth', link: '/packages/auth/totp' },
              { text: 'Reference', link: '/packages/auth/reference' },
              { text: 'Testing', link: '/packages/auth/testing' },
            ],
          },
          {
            text: 'ACL',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/acl/' },
              { text: 'Roles and grants', link: '/packages/acl/roles' },
              { text: 'Displaying access', link: '/packages/acl/screens' },
              { text: 'People and machines', link: '/packages/acl/subjects' },
              { text: 'Superadmin', link: '/packages/acl/superadmin' },
              { text: 'Gating routes', link: '/packages/acl/http' },
              { text: 'Cache', link: '/packages/acl/cache' },
              { text: 'Reference', link: '/packages/acl/reference' },
              { text: 'Testing', link: '/packages/acl/testing' },
            ],
          },
          {
            text: 'Query',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/query/' },
              { text: 'Schema reference', link: '/packages/query/schema' },
              { text: 'URL parameters', link: '/packages/query/query-string' },
              { text: 'Advanced', link: '/packages/query/advanced' },
            ],
          },
          {
            text: 'Storage',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/storage/' },
              { text: 'Drivers', link: '/packages/storage/drivers' },
              { text: 'Configuration', link: '/packages/storage/configuration' },
              { text: 'Advanced', link: '/packages/storage/advanced' },
            ],
          },
          {
            text: 'Media',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/media/' },
              { text: 'Orphan cleanup', link: '/packages/media/orphans' },
              { text: 'Reference', link: '/packages/media/reference' },
              { text: 'Testing', link: '/packages/media/testing' },
            ],
          },
          {
            text: 'Mailing',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/mailing/' },
              { text: 'Queueing', link: '/packages/mailing/queue' },
              { text: 'Worker', link: '/packages/mailing/worker' },
              { text: 'Providers', link: '/packages/mailing/providers' },
              { text: 'Reference', link: '/packages/mailing/reference' },
              { text: 'Testing', link: '/packages/mailing/testing' },
            ],
          },
          {
            text: 'Payment',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/payment/' },
              { text: 'Creating payments', link: '/packages/payment/create' },
              { text: 'Catalog sync', link: '/packages/payment/catalog' },
              { text: 'Webhooks', link: '/packages/payment/webhooks' },
              { text: 'Refunds', link: '/packages/payment/refunds' },
              { text: 'Providers', link: '/packages/payment/providers' },
              { text: 'Reference', link: '/packages/payment/reference' },
              { text: 'Testing', link: '/packages/payment/testing' },
            ],
          },
          {
            text: 'DBmigrate',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/dbmigrate/' },
              { text: 'Commands', link: '/packages/dbmigrate/commands' },
              { text: 'Library', link: '/packages/dbmigrate/library' },
              { text: 'Drivers', link: '/packages/dbmigrate/drivers' },
              { text: 'Reference', link: '/packages/dbmigrate/reference' },
              { text: 'Testing', link: '/packages/dbmigrate/testing' },
            ],
          },
          {
            text: 'Discount',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/discount/' },
              { text: 'Creating discounts', link: '/packages/discount/create' },
              { text: 'Resolving at checkout', link: '/packages/discount/resolve' },
              { text: 'Fulfillment & history', link: '/packages/discount/fulfill' },
              { text: 'Reference', link: '/packages/discount/reference' },
              { text: 'Testing', link: '/packages/discount/testing' },
            ],
          },
          {
            text: 'Router',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/router/' },
              { text: 'Chaining', link: '/packages/router/chaining' },
              { text: 'Groups', link: '/packages/router/groups' },
              { text: 'Middleware and rate limits', link: '/packages/router/middleware' },
              { text: 'CORS and roots', link: '/packages/router/cors' },
              { text: 'Reference', link: '/packages/router/reference' },
              { text: 'Testing', link: '/packages/router/testing' },
            ],
          },
          {
            text: 'AI Support',
            collapsed: true,
            items: [
              { text: 'Getting started', link: '/packages/aisupport/' },
              { text: 'Chat and conversations', link: '/packages/aisupport/chat' },
              { text: 'Documentation search', link: '/packages/aisupport/docs' },
              { text: 'LLM and retrieval', link: '/packages/aisupport/llm' },
              { text: 'Analytics', link: '/packages/aisupport/analytics' },
              { text: 'Configuration', link: '/packages/aisupport/config' },
              { text: 'Error handling', link: '/packages/aisupport/errors' },
              { text: 'Reference', link: '/packages/aisupport/reference' },
            ],
          },
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
