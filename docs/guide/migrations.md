# Migrations

SQL for kit tables lives next to that folder (`payment/migration/`, `discount/migrations/`, `mailing/migrations/`). The migrator only runs `db/migrations/`, so you publish, then migrate:

```bash
make -C payment migrate-publish
make -C discount migrate-publish
make -C mailing migrate-publish
# optional: TARGET_DIR=/path/to/db/migrations
```

Publish re-timestamps files after the latest file already in the target dir and **skips slugs that already exist**. New kit migrations still land; files you already published are not overwritten.

`query/` has **no tables**. `storage/` has **no tables** (files live on disk or in S3; media rows are yours).

## Default: bigint ids on your catalog

The scaffold assumes your primary keys (`users`, `orders`, `products`, …) are `bigint`. Kit create-table SQL stores those foreign keys as `bigint` / `int64`.

`discount/` splits this: portable create tables, then an FK file (`add_discount_foreign_keys`). `payment/` currently puts `payments.order_id → orders(id)` **inside** `create_payments_table` — if you change types, edit that published file, not a separate FK-only file.

## Other PK types (UUID, …)

Do this **once**, on the copies in **`db/migrations/`**, **before** the first `migrate-up`:

1. Change those foreign-key **column types** (`order_id`, `user_id`, `product_id`, …) to match your PK (`uuid`, …). Changing only `REFERENCES` is not enough — Postgres will refuse `bigint` → `uuid`.
2. Point the **FK** at your table and column.
3. Match the Go fields in that kit folder (`OrderInput.ID`, `Payment.OrderID`, discount `UserID`, …). SQL `uuid` + Go `int64` will not work.
4. Then migrate.

Do not re-edit after `migrate-up`. That needs a new `ALTER COLUMN` migration in `db/migrations/`.

Internal kit FKs (e.g. `discount_products.discount_id → discounts(id)`) stay as written. Snapshot tables such as `payment_discounts` stay **without** FKs to payments, orders, or discounts — copied values only.
