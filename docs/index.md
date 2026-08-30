---
layout: home

hero:
  name: GoMakeNow
  text: A Go boilerplate
  tagline: Scaffold the repo and query, payment, mailing, storage, and discount are already in it. You write routes, models, and product rules — not list engines or Stripe clients.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Packages
      link: /packages/

features:
  - title: query
    details: Cursor pagination, filters, search, and sort. Put Schema() on your model; List does the rest.
    link: /packages/query
  - title: storage
    details: Local disk and S3 drivers. Public vs private URLs. You write upload HTTP and media rows.
    link: /packages/storage
  - title: mailing
    details: Outbound queue, Mailgun / Mailtrap, retries. You render HTML and decide who gets mail.
    link: /packages/mailing
  - title: payment
    details: Gateway, Stripe / Lemon Squeezy / NowPayments / wallet, webhooks, refunds. You write checkout and fulfillment.
    link: /packages/payment
  - title: discount
    details: Vouchers, referrals, per-product rates, payment snapshots. You write checkout UX.
    link: /packages/discount
---
