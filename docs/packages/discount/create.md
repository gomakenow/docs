---
title: Creating discounts — Discount
description: CreateDiscountWithProductRates, all input fields, updating, replacing rates, and deleting campaigns.
---

# Creating discounts

[Getting started](./) showed a minimal `CreateDiscountWithProductRates` call to get a campaign running. This page covers everything else: what each field does, the constraints enforced at the database level, how to update an existing campaign, how to replace its rates, and how to delete it.

---

## How CreateDiscountWithProductRates works

`discount.CreateDiscountWithProductRates` is the main entry point for your admin handler. It runs in a single transaction: either the discount row and all its rate rows are committed together, or nothing is written.

```go
import (
    "your-module/discount"
    "your-module/discount/types"
)

result, err := discount.CreateDiscountWithProductRates(db, types.CreateDiscountInput{
    Type:      "voucher",
    Code:      "SUMMER25",
    StartDate: time.Now().UTC(),
    Products: []types.DiscountProductInput{
        {ProductID: 1, ValueType: "percent", Value: 25},
    },
}, &adminUserID) // createdBy — pass nil if you do not track who created it
if err != nil {
    // See the Errors section below
}

discount := result.Discount  // *models.Discount
rates    := result.Products  // []models.DiscountProduct
```

`Products` is required — you cannot create a discount with no rates. Pass at least one item.

---

## Discount fields

### Type

`"voucher"` or `"referral"`. The type decides shape constraints:

- A **voucher** must have `ReferralID = nil`. It is a standalone code — any qualifying buyer can use it.
- A **referral** must have `ReferralID` set. The rate is tied to a specific referral relationship in your app.

Passing the wrong shape returns `ErrDiscountVoucherShapeInvalid` or `ErrDiscountReferralShapeInvalid`.

### Code

Unique across all discounts. The package normalizes it to uppercase before insert, so `save20`, `Save20`, and `SAVE20` are treated as the same code. Passing a duplicate returns `ErrDiscountCodeDuplicate`.

The code is **immutable** after creation. If you need a new code, create a new discount and disable the old one.

### StartDate and EndDate

`StartDate` is required. The discount becomes active at this time.

`EndDate` is optional. When set, it must be:
- In the future at creation time (returns `ErrDiscountEndDateMustBeFuture` otherwise)
- After `StartDate` (returns `ErrDiscountDateRangeInvalid` otherwise)

`nil` end date means the discount never expires on its own. You can still disable it manually.

### MaxUses

`nil` = unlimited. When set, must be `> 0`.

When `UsedCount` reaches `MaxUses`, `IsUsable` returns `false`. The counter is incremented atomically by `IncrementDiscountUsage` when the payment succeeds.

::: info User-restricted discounts are always single-use
If you set `UserID`, `MaxUses` is forced to `1` automatically regardless of what you passed. A user-restricted discount is designed for exactly one buyer.
:::

### Disabled

`false` by default. Set to `true` to immediately deactivate a campaign without deleting it. Disabled discounts are never returned by `IsUsable` or the resolve functions — they appear as not applicable.

Use this when you want the campaign row to stay in the database but stop accepting new uses. Deleting is also fine — history lives on `payment_discounts`, not on this row.

### UserID

Restricts the discount to one specific user. Only that user can apply it. `IsUsable` returns `ErrDiscountNotForUser` for everyone else. Forces `MaxUses = 1`.

`nil` = global — any user (or guest) can use it, subject to window and cap.

### ReferralID

Required for `"referral"` type, must be `nil` for `"voucher"`. Points at a row in your `referrals` table. The FK is wired by the host migration.

### Meta

Free JSONB stored as-is. The package never reads it. Use it for whatever your host needs:

```json
{
  "autoApply": true,
  "showAsLandingBanner": true,
  "bannerHtml": "<p>Save 20% this summer!</p>"
}
```

Your services query it back with `MetaContains` in `GetDiscountRatesForProductsByMeta`. The package just stores and returns it.

### Description

Optional free-text description. Stored on the row and returned in snapshots.

---

## Rate fields

Each entry in `Products` attaches a rate to one catalog product:

| Field | Required | Notes |
|---|---|---|
| `ProductID` | yes | Your `products.id`. Referenced by the host FK. |
| `ValueType` | yes | `"percent"` — 0 to 100. `"fixed"` — any non-negative amount in the checkout currency. |
| `Value` | yes | For `"percent"`: the percentage taken off (20 = 20%). For `"fixed"`: the amount subtracted, in the same currency as the list price, capped at list price. |

Duplicate `ProductID` within the same `Products` slice returns an error before any DB write.

The rate row itself has no currency column. A `"fixed"` value of `5` means 5 units of whatever currency the buyer is checking out in — EUR, USD, or anything else you pass as the list price. Currency is recorded later, on the `payment_discounts` snapshot, when you call `BuildPaymentDiscountSnapshot`.

---

## Updating a discount

`models.UpdateDiscount` applies a partial update. Only the fields you include are changed — fields you leave `nil` are untouched.

The update pattern uses `*NullableField[T]`:
- outer pointer `nil` → skip this field entirely
- outer pointer set, inner `Value` `nil` → set to `null`
- outer pointer set, inner `Value` non-nil → set to that value

```go
import discountmodels "your-module/discount/models"
import "your-module/discount/types"

updated, err := discountmodels.UpdateDiscount(db, discountID, types.UpdateDiscountInput{
    // Disable the campaign immediately
    Disabled: &types.NullableField[bool]{Value: boolPtr(true)},

    // Extend by one week
    EndDate: &types.NullableField[time.Time]{Value: timePtr(time.Now().AddDate(0, 0, 7))},

    // Remove the end date entirely (make it open-ended)
    // EndDate: &types.NullableField[time.Time]{Value: nil},
})
```

What can be updated:

| Field | Notes |
|---|---|
| `Type` | Can be changed between `voucher` and `referral`. Shape constraints re-apply. |
| `Code` | Immutable — the field exists but updates are rejected. |
| `Description` | Free text. |
| `StartDate` | Can be moved. |
| `EndDate` | Can be extended, removed (`nil`), or set. Must be in the future. |
| `MaxUses` | Can increase the cap. Setting to `nil` makes it unlimited again. |
| `Disabled` | Toggle on/off. |
| `UserID` | Can be changed. Switching to a user re-enforces `MaxUses = 1`. |
| `ReferralID` | Can be changed. Shape constraints re-apply. |
| `Meta` | Replaced entirely — not merged. Send the full object when updating. |

---

## Updating individual rates

To change one rate without touching the others:

```go
updated, err := discountmodels.UpdateDiscountProduct(db, discountID, rateID, types.UpdateDiscountProductInput{
    ValueType: &types.NullableField[string]{Value: strPtr("fixed")},
    Value:     &types.NullableField[float64]{Value: float64Ptr(10.0)},
})
```

To delete one rate:

```go
err := discountmodels.DeleteDiscountProduct(db, discountID, rateID)
```

## Replacing all rates at once

If the admin sends a new set of products in one form submission, use `ReplaceDiscountProducts`. It deletes all existing rates for that discount and inserts the new ones in a single transaction:

```go
newRates, err := discountmodels.ReplaceDiscountProducts(db, discountID, []types.DiscountProductInput{
    {ProductID: 1, ValueType: "percent", Value: 15},
    {ProductID: 3, ValueType: "percent", Value: 15},
})
```

The discount row itself is not touched. Only the `discount_products` rows are replaced.

---

## Deleting a discount

You can delete a discount whether it has been used or not. That is why `payment_discounts` exists: it is copied history with no foreign key back to `discounts`, so deleting the campaign does not erase what buyers already paid.

```go
err := discountmodels.DeleteDiscount(db, discountID)
```

What happens:

- The `discounts` row is removed.
- Its `discount_products` rates go with it (`ON DELETE CASCADE`).
- Every `payment_discounts` snapshot stays. Receipts, refunds, and admin history still show the code, amounts, and currency from checkout.

`used_count > 0` does **not** block the delete. If you only want to stop new uses and keep the campaign row around for the admin list, set `Disabled = true` instead.

A missing id returns `gorm.ErrRecordNotFound`.

---

## Errors

| Error | When you see it |
|---|---|
| `ErrDiscountCodeDuplicate` | Code already exists in `discounts` |
| `ErrDiscountDateRangeInvalid` | `EndDate` ≤ `StartDate` |
| `ErrDiscountEndDateMustBeFuture` | `EndDate` is in the past |
| `ErrDiscountVoucherShapeInvalid` | Voucher type with `ReferralID` set |
| `ErrDiscountReferralShapeInvalid` | Referral type without `ReferralID` |
| `ErrDiscountMaxUsesInvalid` | `MaxUses` set to `<= 0` |
| `ErrDiscountUserRestrictedMaxUses` | User-restricted discount with `MaxUses != 1` |
| `ErrDiscountUserNotFound` | `UserID` references a non-existent user |
| `ErrDiscountReferralNotFound` | `ReferralID` references a non-existent referral |
| `ErrDiscountProductDuplicateRate` | Two rates for the same `ProductID` under one discount |
| `ErrDiscountProductNotFound` | `ProductID` references a non-existent product |
