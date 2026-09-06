---
title: Catalog sync — Payment
description: gateway_products, SyncProducts, lazy sync during Create, and idempotency prefixes.
---

# Catalog sync

Some payment providers need a product object in **their** catalog before they can show your product name on a hosted checkout. Stripe is the example that ships with the package — a Checkout Session must reference a real Stripe Product id. There is no catch-all one-time item in Stripe the way Lemon Squeezy has.

The `gateway_products` table is where the package stores the link: your internal `products.id` on one side, the provider's catalog object id on the other.

For Lemon Squeezy, NowPayments, and the wallet provider, this table is never used. `SyncProducts` for those providers is a no-op — it returns one result per input with an empty `ProviderProductID` and no error. If you are not using Stripe, you can stop reading here. The table still exists after the migration; it just stays empty.

---

## What gateway_products stores

One row per internal product:

| Column | What it holds |
|---|---|
| `product_id` | FK → your `products.id`. Cascades on delete, so removing the product row removes the catalog link too. |
| `stripe_product_id` | The provider's catalog object id, `prod_…` for Stripe. Empty until a sync runs. |
| `product_name` | The product name that was last successfully pushed to the provider. |

The `product_name` column exists for a specific reason: the package compares it to the name you pass in when deciding whether to make a network call. If the name has not changed since the last sync, it skips the round-trip entirely. The package never queries your `products` table directly — it only knows the id and name you give it.

---

## Syncing products

`gw.SyncProducts` takes a list of your products and ensures each one has a matching object in the provider's catalog.

```go
results, err := gw.SyncProducts(ctx, db, paymentconfigs.Provider_Stripe, []paymentProviders.SyncProductInput{
    {ID: 42, Name: "Pro plan",     IdempotencyKeyPrefix: "myapp"},
    {ID: 43, Name: "Credits pack", IdempotencyKeyPrefix: "myapp"},
})
```

For each product, Stripe does one of three things:

- **No link yet, or the remote product was archived** — creates a new Stripe Product. Saves the provider id and the name to `gateway_products`.
- **Link exists and the name has not changed** — skips entirely. No network call.
- **Link exists but the name changed** — fetches the remote product, renames it if it is still active, or recreates it if Stripe deleted it. Updates `product_name`.

Per-product errors do **not** fail the whole batch. `SyncProducts` can return `nil` at the top level while some `results[i].Err` are set. Always inspect every item in the results slice. Catalog failures wrap `paymenterrors.ErrCatalogSync`.

Call this from an admin "Sync products" button after you change any product name. Use the **same name format** you pass in `SubOrder.Name` when calling `Create`. If you use `"Pro plan"` in `SyncProducts` but `"Acme - Pro plan"` in `Create`, every checkout will trigger a rename.

---

## You do not need to sync before the first checkout

You do not have to run `SyncProducts` before a buyer can checkout. When you call `gw.Create` for a Stripe checkout, the package automatically runs the same create / rename / skip / recreate logic for that one product on the spot.

`CreateInput.CatalogIdempotencyKeyPrefix` is forwarded to that lazy sync. If you omit it, keys fall back to `prod-{id}`.

If the lazy sync fails, `Create` returns `paymenterrors.ErrCatalogSync`. If the Checkout Session creation fails after a successful sync, you get `paymenterrors.ErrCheckoutCreate`. `paymenterrors.PublicCheckoutMessage` maps both to a safe, short message for the browser.

---

## Idempotency prefixes — why they matter {#idempotency-prefixes--why-they-matter}

Stripe remembers the first API request for a given idempotency key. If you later change the product name (or any other creation parameter) but reuse the same key, Stripe returns an error saying the request conflicts with the previous one.

The fix is not to change the name — it is to change the **prefix family**. Say you have been using `myapp` as the prefix (keys like `myapp-prod-42`). You decide to start prefixing all product names with `"Acme - "`. Bump the prefix to `myapp2`. Now creates use `myapp2-prod-42`. Old Stripe products stay as they are; new ones use the new keys.

Two separate apps sharing one Stripe account **must** use different prefixes. Without that, app A and app B will both try to create `prod-42` under the same key and fight over it.

---

## Wiring this in an admin service

Typical flow for an "admin sync" action:

1. Load the products you want to sync from your `products` table.
2. Map each to a `SyncProductInput` — this is where you apply any branding (`"Pro plan"` vs `"Acme - Pro plan"`).
3. Call `gw.SyncProducts(ctx, db, paymentconfigs.Provider_Stripe, inputs)`.
4. Show the per-item results in your admin UI. Make errors visible — a silent catalog failure leads to confusing checkout errors later.

Do not import `models.Product` inside `backend/payment/`. The package only knows `int64` id + `string` name.
