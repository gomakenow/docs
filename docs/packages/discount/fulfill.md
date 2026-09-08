---
title: Fulfillment & history — Discount
description: Freeze the snapshot when you create the payment, increment usage when it succeeds, then read payment_discounts for history.
---

# Fulfillment & history

Recording a discount is two separate moments. Do not fold them into one call after the buyer pays.

1. **When you create the payment** — freeze what this checkout will get into `payment_discounts`. The buyer has not paid yet. You already have the discount and rate in memory from resolving at checkout.
2. **When the payment succeeds** — increment `discounts.used_count` from the snapshot's code. If the live campaign was deleted in the meantime, skip the increment. The snapshot is already there.

That split matches how checkout actually works: the hosted page or crypto invoice can sit open for a long time. History must not depend on the live campaign still existing when money arrives.

---

## Snapshot when you create the payment

Call this once per discounted product line, in the same place you create (or reuse) the `payments` row.

`BuildPaymentDiscountSnapshot` only builds a struct from the values you pass. `CreatePaymentDiscount` inserts it.

```go
import (
    "your-module/discount"
    discountmodels "your-module/discount/models"
)

existing, err := discountmodels.GetPaymentDiscountByPaymentIDAndProductID(db, pay.ID, productID)
if err != nil {
    return err
}
if existing != nil {
    // Payment reuse — do not write a second snapshot for this line.
    return nil
}

row := discount.BuildPaymentDiscountSnapshot(
    pay.ID,
    order.ID,
    productID,
    productName,       // name at checkout time
    listPrice,         // original price before discount
    &rates.Discount,   // from resolve
    rate,              // *models.DiscountProduct from resolve
    order.Currency,    // checkout currency — "EUR", "USD", …
)
_, err = discountmodels.CreatePaymentDiscount(db, row)
```

Pass the currency the buyer checked out in. The snapshot stores it next to the amounts so a receipt can render in the same currency later. An empty string falls back to `"USD"` only as a default for old callers; do not rely on that if your store is not USD.

If this product line had no discount (`applied == nil`), skip both calls. There is nothing to freeze.

### What the snapshot stores

| Field | What it contains |
|---|---|
| `ID` | UUID of this snapshot row |
| `PaymentID` | Your `payments.id` |
| `OrderID` | Your `orders.id` |
| `ProductID` | The product id |
| `ProductName` | Product name at checkout time |
| `DiscountCode` | The code, frozen |
| `DiscountType` | `"voucher"` or `"referral"`, frozen |
| `ValueType` | `"percent"` or `"fixed"`, frozen |
| `Value` | The rate value, frozen |
| `BaseAmount` | List price at checkout, rounded to 2 decimal places |
| `DiscountedAmount` | Amount taken off, in `Currency`, rounded to 2 decimal places |
| `Currency` | ISO 4217 code of the checkout |

Once written, the row is never updated. If the campaign is later changed or deleted, the snapshot still reflects what this payment was priced with.

---

## Increment usage when the payment succeeds

Do this in the handler that marks the order paid and grants access. Read the snapshots for this payment, then increment by code:

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
        // Live campaign gone — log it. Do not fail the order. The snapshot remains.
    }
}
```

`IncrementDiscountUsage` returns `ErrDiscountNotFound` when there is no `discounts` row for that code. Treat that as "skip usage," not as a failed payment.

::: warning Write the snapshot at payment create, not here
If you wait until success to insert `payment_discounts`, a deleted campaign (or a lost job) leaves you with no history of what the buyer was charged. Usage can be skipped. The snapshot cannot.
:::

---

## If the campaign is deleted after checkout

This is the normal reason for the split:

| Moment | Live `discounts` row | What you do |
|---|---|---|
| Payment created | Usually still there | Snapshot is written from in-memory rates. Does not re-read the live row. |
| Payment succeeds | Might already be deleted | Increment by snapshot code. If not found, skip. Snapshot already in the database. |

Receipts, refunds, and admin views always read `payment_discounts`. They never need the live campaign.

---

## One row per product per payment

A snapshot is not “one row per order” or “one row per discount code.” It is **one row for each product on a given payment**.

That is because a cart can have more than one product, and the same code can apply to several of them at different rates. `SAVE20` might take 20% off Product A and 10% off Product B. Those are two lines on the receipt, so they are two rows, both pointing at the same `payments.id`.

The database enforces this with a unique index on `(payment_id, product_id)`. You cannot store two snapshots for the same product on the same payment.

That rule also covers a common checkout quirk: **payment reuse**. The buyer opens checkout, you create a payment, you write the snapshot. Then they close the tab and come back. Your app often reuses the same in-progress payment instead of creating a new one. If you insert again, the unique index would blow up. So before you insert, look up the existing row:

```go
existing, err := discountmodels.GetPaymentDiscountByPaymentIDAndProductID(db, pay.ID, productID)
if existing != nil {
    // Already frozen for this payment + product. Leave it.
}
```

Keep the original snapshot. Do not overwrite it with a later price or a different code — that row is what this payment was priced with.

If you skip the lookup and insert twice, `CreatePaymentDiscount` fails. Treat that as a bug in your reuse handling, not as something to retry blindly.

---

## Reading discount history

Always read `payment_discounts` — not the live `discounts` row.

```go
import discountmodels "your-module/discount/models"

// All product-line snapshots for one payment (most common)
snapshots, err := discountmodels.GetPaymentDiscountsByPaymentID(db, paymentID)

// One specific product on a payment
snapshot, err := discountmodels.GetPaymentDiscountByPaymentIDAndProductID(db, paymentID, productID)

// All snapshots across all payments for an order (admin order detail)
snapshots, err := discountmodels.GetPaymentDiscountsByOrderID(db, orderID)
```

None of these return an error when there are no rows — they return an empty slice or `nil`. A missing row means no discount was applied to that payment or product.

### Building a receipt

```go
snapshots, _ := discountmodels.GetPaymentDiscountsByPaymentID(db, paymentID)
for _, s := range snapshots {
    fmt.Printf("Product: %s\n", s.ProductName)
    fmt.Printf("List price: %.2f %s\n", s.BaseAmount, s.Currency)
    fmt.Printf("Discount (%s): -%.2f %s\n", s.DiscountCode, s.DiscountedAmount, s.Currency)
    fmt.Printf("Final price: %.2f %s\n", s.BaseAmount - s.DiscountedAmount, s.Currency)
}
```

### Refund screens

Use the snapshot, not a fresh `DiscountAmount` call. The live rate or list price may have changed.

```go
snapshot, err := discountmodels.GetPaymentDiscountByPaymentIDAndProductID(db, paymentID, productID)
if snapshot != nil {
    finalPrice := snapshot.BaseAmount - snapshot.DiscountedAmount
}
```

### Admin order view

```go
snapshots, err := discountmodels.GetPaymentDiscountsByOrderID(db, orderID)
// ordered by payment_id, then product_id
```

---

## Snapshot fields reference

| Field | DB column | Notes |
|---|---|---|
| `ID` | `id` | UUID, primary key |
| `PaymentID` | `payment_id` | `payments.id` — copied value, no FK |
| `OrderID` | `order_id` | `orders.id` — copied value, no FK |
| `DiscountType` | `discount_type` | `"voucher"` or `"referral"` |
| `ProductID` | `product_id` | `products.id` — copied value, no FK |
| `ProductName` | `product_name` | Name at checkout time |
| `DiscountDescription` | `discount_description` | Optional text from the campaign |
| `DiscountCode` | `discount_code` | The code, frozen |
| `ReferralID` | `referral_id` | Copied from discount if type is referral |
| `Meta` | `meta` | Reserved (currently always null) |
| `ValueType` | `value_type` | `"percent"` or `"fixed"` |
| `Value` | `value` | The rate value, frozen |
| `BaseAmount` | `base_amount` | List price, rounded |
| `DiscountedAmount` | `discounted_amount` | Amount taken off, rounded |
| `Currency` | `currency` | Checkout currency (ISO 4217). Empty string falls back to `"USD"`. |
| `CreatedAt` | `created_at` | Row creation time |
