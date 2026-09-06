# Packages

These are **folders in the scaffolded repo**, same Go module as your `handlers/` and `models/`. You do not add them to `go.mod` as outside libraries.

::: info Filling in
[Query](./query/), [storage](./storage/), [media](./media/), [mailing](./mailing/), and [payment](./payment/) are written. Remaining pages are still scaffolds: discount.
:::

| Folder | What it does | What you still write |
|---|---|---|
| [Query](./query/) | Cursor lists: filter, search, sort | Routes, auth, GORM models, JSON transformers |
| [storage](./storage/) | Local / S3 drivers, public vs private URLs | Upload HTTP, serving files, access control |
| [media](./media/) | Atomic uploads + DB tracking, URL resolution, orphan cleanup | Object keys, ACLs, feature FK columns, schedule the cleanup job |
| [mailing](./mailing/) | DB queue, worker, Mailgun/Mailtrap, optional tracking | Templates, audiences, consent, unsubscribe HTTP, attempt log |
| [Payment](./payment/) | Gateway, Stripe/LS/NP/wallet, free checkouts, webhooks, refunds, catalog | Orders, checkout settings, fulfillment, which rails are on |
| [discount](./discount) | Vouchers, referrals, rates, payment snapshots | Auto-apply UX, landing banners |
