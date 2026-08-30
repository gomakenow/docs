# Architecture

After you scaffold, the repo already contains the kit folders. Your app code sits next to them in the **same module**.

```
Your handlers / auth / admin UI / product rules
        │
        ▼
┌─────────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐
│  payment/   │  │ discount/│  │ mailing/│  │ storage/│  │  query/  │
│   Gateway   │  │  Engine  │  │ Engine  │  │ drivers │  │ List[T]  │
└──────┬──────┘  └────┬─────┘  └────┬────┘  └────┬────┘  └────┬─────┘
       │              │             │            │            │
       └──────────────┴─────────────┴────────────┴────────────┘
                              │
                    PostgreSQL (kit tables + your users / orders / products)
```

## What you write vs what already shipped

| Already in the repo | You write |
|---|---|
| Engines, providers/drivers, kit tables, sentinel errors, webhook *verification* | HTTP routes, authentication, admin UI, product rules, fulfillment, which providers are on |

Call the folder’s public surface (`query.List`, `payment.Gateway`, `mailing.Engine`, a storage driver). Do not import Stripe or Mailgun from a handler. Tests pass a mock of that surface.

Your catalog ids (`orders`, `users`, `products`) are foreign keys **into your tables**. The kit stores them as `bigint` / `int64`. If your primary keys are UUID (or anything else), edit the published columns and FKs in `db/migrations/` before the first migrate — see [Migrations](./migrations).

## Two kinds of ids

`payments.id` is a UUID owned by `payment/`. Stripe / NowPayments / wallet use that as the correlation id.

`order_id`, `user_id`, `product_id` point at **your** rows. The engine stores them and looks them up by equality. It does not generate them.
