# Packages

These are **folders in the scaffolded repo**, same Go module as your `handlers/` and `models/`. You do not add them to `go.mod` as outside libraries.

::: info Filling in
[Query](./query/) is written. Remaining pages are still scaffolds: storage, mailing, payment, discount.
:::

| Folder | What it does | What you still write |
|---|---|---|
| [Query](./query/) | Cursor lists: filter, search, sort | Routes, auth, GORM models, JSON transformers |
| [storage](./storage) | Local / S3 drivers, public vs private URLs | Upload HTTP, image/video validation, media table |
| [mailing](./mailing) | Queue, providers, retries, optional tracking | Templates, audiences, unsubscribe, admin UI |
| [payment](./payment) | Gateway, providers, webhooks, refunds, catalog links | Checkout, fulfillment, which providers are on |
| [discount](./discount) | Vouchers, referrals, rates, payment snapshots | Auto-apply UX, landing banners |
