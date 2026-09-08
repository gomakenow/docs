---
title: Discount
description: Vouchers, referral codes, per-product rates, and immutable payment snapshots. You own the checkout UX and the business rules.
---

# Discount

<Badge type="tip" text="Requires migration" />

The `discount` package (`backend/discount/`) is how your app manages discount campaigns — voucher codes, referral codes, per-product rates — and permanently records what each buyer actually saved at the moment they paid.

Without this package you would write discount logic scattered across handlers: check the code, calculate the price reduction, somehow log what was applied, and remember to increment usage somewhere. The package centralizes that. You create campaigns in the database, look up rates at checkout, freeze what was applied when you create the payment, and increment usage when that payment succeeds.

```
Admin creates a campaign — code, rate per product, window, optional cap
  CreateDiscountWithProductRates(db, input, createdBy)

        │
Buyer arrives at checkout
        │
        ├── Look up the code (or auto-apply by meta)
        │     GetDiscountRatesForProductsByDiscountCode(db, code, productIDs)
        │     GetDiscountRatesForProductsByMeta(db, opts)
        │
        ├── Check it is usable right now (window, cap, user restriction)
        │     rates.Discount.IsUsable(now, &userID)
        │
        ├── Get the rate for each product in the cart
        │     rates.RateForProduct(productID)
        │
        └── Calculate discounted price   ← your code sets this on the order
              DiscountAmount(listPrice, rate.ValueType, rate.Value)

You create the payment (checkout session / invoice)
        │
        BuildPaymentDiscountSnapshot(...)
        CreatePaymentDiscount(db, snapshot)   ← freeze what this payment will get
                                                (before the buyer has paid)

Payment succeeds
        │
        IncrementDiscountUsage(db, snapshot.DiscountCode)   ← live campaign counter
        (if the campaign was deleted, skip usage — the snapshot is already there)

Later — receipt, admin view, refund screen
        │
        GetPaymentDiscountsByPaymentID(db, paymentID)
        │
        └── Read the snapshot, not the live campaign
              → base price, discounted amount, code — frozen at checkout time,
                survives even if the campaign is later deleted
```

The package never reads your `orders`, `users`, or `products` tables. It only knows the `int64` ids and names you pass in. You own the checkout handler, the pricing API, the admin UI, and the decision of which discount wins when multiple could apply.

::: info What discount does not do
The package does not pick which discount to show a visitor, decide whether a referral beats a voucher, stack multiple codes, or register any HTTP routes. It does not know about orders or payments — you pass those ids in. Your services own priority and UX rules.
:::

You can wire the whole thing in **four steps**: publish the migration, create your first campaign, resolve rates at checkout, then freeze a snapshot when you create the payment and increment usage when it succeeds.

---

## Step 1 — Publish and run the migration

The package ships its own SQL. Publish it into your app's migrations folder and apply:

```sh
make -C backend/discount migrate-publish
make migrate-up
```

This creates three tables:

| Table | What it stores |
|---|---|
| `discounts` | One row per campaign — code, window, usage cap, type, optional user restriction |
| `discount_products` | One rate per product under a discount: `percent` or `fixed` |
| `payment_discounts` | Frozen copy of what was applied on one product line of a payment |

The published SQL also includes `add_discount_foreign_keys`. That file wires `discounts` and `discount_products` to your host catalog — you do **not** need to write a new FK migration:

| Column | References | On delete |
|---|---|---|
| `discounts.created_by` | `users(id)` | `SET NULL` |
| `discounts.user_id` | `users(id)` | `RESTRICT` |
| `discounts.referral_id` | `referrals(id)` | `RESTRICT` |
| `discount_products.product_id` | `products(id)` | `RESTRICT` |

Those tables must exist before `migrate-up`. The FK columns assume **bigint** primary keys — same as the payment package. If your ids are UUIDs or your table names differ, edit the published copies in `db/migrations/` before applying. If you have no `referrals` table, remove the referral check and FK block from the published file. See [Migrations](/guide/migrations).

::: warning Do not add FKs from `payment_discounts`
That table is immutable history — no FKs to payments, orders, products, or discounts. Its rows survive if you delete the campaign, the product, or the payment. The FK file already drops any such constraints if they exist.
:::

You do not need to understand every column now. Full schemas are on the [Reference](./reference#tables) page.

---

## Step 2 — Create a campaign

Call `discount.CreateDiscountWithProductRates` from your admin handler. It creates the discount row and all its rate rows in one transaction — either both succeed or neither does.

```go
import (
    "your-module/discount"
    "your-module/discount/types"
)

result, err := discount.CreateDiscountWithProductRates(db, types.CreateDiscountInput{
    Type:      "voucher",
    Code:      "SAVE20",
    StartDate: time.Now().UTC(),
    EndDate:   timePtr(time.Now().AddDate(0, 1, 0)), // one month from now
    MaxUses:   intPtr(500),                          // nil = unlimited
    Disabled:  boolPtr(false),
    Products: []types.DiscountProductInput{
        {ProductID: 1, ValueType: "percent", Value: 20},
        {ProductID: 2, ValueType: "fixed",   Value: 5},
    },
}, &adminUserID)
if err != nil {
    // validations.ErrDiscountCodeDuplicate, ErrDiscountDateRangeInvalid, etc.
}
// result.Discount — the inserted discount row
// result.Products — the inserted rate rows
```

Full field-by-field breakdown and update/delete options are on the [Creating discounts](./create) page.

---

## Step 3 — Resolve rates at checkout

When the buyer arrives at checkout, look up what their discount offers. Then check if it is currently usable and calculate the final price.

```go
import "your-module/discount"
import discountvalidations "your-module/discount/validations"

// 1. Look up the code the buyer typed
rates, err := discount.GetDiscountRatesForProductsByDiscountCode(db, "SAVE20", []int64{productID})
if err != nil {
    if errors.Is(err, discountvalidations.ErrDiscountNotFoundOrNotApplicable) {
        // code doesn't exist, or exists but has no rate for these products
    }
    return err
}

// 2. Check it's actually usable right now for this user
usable, err := rates.Discount.IsUsable(time.Now().UTC(), &userID)
if !usable {
    // err tells you why: ErrDiscountNotUsable, ErrDiscountNotForUser, etc.
}

// 3. Get the rate for this product
rate := rates.RateForProduct(productID)
if rate == nil {
    // this product has no rate under the discount
}

// 4. Calculate the price reduction
discountAmt := discount.DiscountAmount(order.Price, rate.ValueType, rate.Value)
finalPrice   := order.Price - discountAmt
```

You set `finalPrice` on the order. The package does not touch your order model.

For discounts the buyer does not type — for example a voucher you marked `{"autoApply":true}` in `meta` — use `GetDiscountRatesForProductsByMeta` instead. `meta` is a free JSON field you own; auto-apply is just one flag you can put there. Full details with scopes, guest vs logged-in users, and priority logic are on the [Resolving discounts](./resolve) page.

---

## Step 4 — Snapshot at payment create, increment on success

Do **not** wait until the buyer has paid to record what discount they got. Write the snapshot when you create the payment (the checkout session, invoice, or wallet address). Increment `used_count` later, when the payment actually succeeds.

That split is intentional. A buyer can sit on a hosted checkout page for minutes. If an admin deletes the campaign in that window, you still have the frozen row. Usage is a live counter — if the campaign is gone, skip the increment and move on.

### When you create the payment

For each product line that has a discount, build the snapshot from the rates you already resolved, then insert it. Skip if this `(payment_id, product_id)` already has a row (payment reuse).

```go
import discountmodels "your-module/discount/models"

existing, err := discountmodels.GetPaymentDiscountByPaymentIDAndProductID(db, pay.ID, productID)
if err != nil {
    return err
}
if existing != nil {
    // this payment was reused — keep the original snapshot
} else {
    row := discount.BuildPaymentDiscountSnapshot(
        pay.ID,
        order.ID,
        productID,
        productName,
        listPrice,          // original price before discount
        &rates.Discount,
        rate,               // *models.DiscountProduct from Step 3
        order.Currency,     // checkout currency, e.g. "EUR"
    )
    _, err = discountmodels.CreatePaymentDiscount(db, row)
}
```

### When the payment succeeds

Read the snapshot you already wrote, then increment usage from its code:

```go
snapshots, err := discountmodels.GetPaymentDiscountsByPaymentID(db, pay.ID)
if err != nil {
    return err
}
for _, s := range snapshots {
    if s.DiscountCode == "" {
        continue
    }
    if err := discountmodels.IncrementDiscountUsage(db, s.DiscountCode); err != nil {
        // campaign deleted after checkout — snapshot stays; log and continue
    }
}
```

After this, always read `payment_discounts` — not the live `discounts` row — for receipts, refunds, and admin views.

Full details, idempotency, and the deleted-campaign case are on the [Fulfillment & history](./fulfill) page.

---

## What happens end to end

1. Admin creates a campaign with rates per product.
2. Buyer types a code at checkout. Your handler resolves it, checks usability, calculates the final price, and passes that price to the payment package.
3. You create the payment and write a `payment_discounts` snapshot from the in-memory rates.
4. Payment succeeds. You increment `used_count` from the snapshot's code. Receipts and refunds read `payment_discounts`.

A referral or auto-apply voucher follows the same path. The only difference is Step 2: you call `GetDiscountRatesForProductsByMeta` instead of looking up by code.

---

## What's next

| Page | What you'll find |
|---|---|
| [Creating discounts](./create) | All `CreateDiscountInput` fields, update patterns, replacing rates, deleting |
| [Resolving at checkout](./resolve) | By code vs by meta, `IsUsable`, query scopes, `DiscountAmount` |
| [Fulfillment & history](./fulfill) | Snapshot at payment create, increment on success, reading history |
| [Reference](./reference) | All function signatures, sentinel errors, table schemas |
| [Testing](./testing) | `distest.OpenTestDB`, seed helpers, running package tests |
