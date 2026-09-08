---
title: Resolving discounts — Discount
description: Look up discount rates at checkout by code or by meta, check usability, calculate the final price.
---

# Resolving discounts at checkout

Before you can show a buyer a discounted price, you need to look up what the discount offers, confirm it is currently usable, and calculate how much to take off. This page covers all of that.

There are two ways to find applicable rates:

- **By code** — the buyer typed a code at checkout, or you have a referral code from a URL parameter.
- **By meta** — you search for any active voucher that matches certain stored properties, like `{"autoApply": true}`.

Both return the same type (`*DiscountRates` or `[]DiscountRates`), and both feed into the same `IsUsable` + `DiscountAmount` pattern.

---

## By code

Use this when the buyer types a code in a checkout field, or when you have a specific referral code from a URL parameter.

```go
import (
    "your-module/discount"
    discountvalidations "your-module/discount/validations"
)

rates, err := discount.GetDiscountRatesForProductsByDiscountCode(
    db,
    "SAVE20",        // the code (case-insensitive; "save20" and "SAVE20" are equivalent)
    []int64{1, 2},  // the product ids in this cart
)
if err != nil {
    if errors.Is(err, discountvalidations.ErrDiscountNotFoundOrNotApplicable) {
        // The code doesn't exist, or it exists but has no rates for any of these products.
        // Show "invalid code" to the buyer.
    }
    return err
}
```

`rates` is `*models.DiscountRates`. It carries the discount row and a product-id → rate map. Passing an empty `productIDs` slice returns all rates for that discount across every product.

---

## Checking usability

`GetDiscountRatesForProductsByDiscountCode` only checks that the code exists and has rates. It does not check whether the discount is within its window, under its cap, or allowed for this specific user. Do that next:

```go
usable, err := rates.Discount.IsUsable(time.Now().UTC(), &userID) // pass nil userID for guests
if !usable {
    // err tells you exactly why:
    //   ErrDiscountNotUsable   — disabled, outside date window, or cap exhausted
    //   ErrDiscountNotForUser  — restricted to a different user
}
```

`IsUsable` takes the current time and an optional user id. Pass `nil` for unauthenticated buyers (guests). User-restricted discounts will return `ErrDiscountNotForUser` for guests.

---

## Getting the rate for a specific product

After checking usability, look up the rate for each product in the cart:

```go
rate := rates.RateForProduct(productID)
if rate == nil {
    // This particular product has no rate under this discount.
    // The discount might still apply to other products in the same cart.
}
```

`RateForProduct` returns `nil` when the product was not listed in `discount_products` for this campaign. That is not an error — a discount can cover only some products. Show a reduced price for covered products and list price for uncovered ones.

---

## Calculating the discount amount

```go
discountAmt := discount.DiscountAmount(listPrice, rate.ValueType, rate.Value)
finalPrice   := listPrice - discountAmt
```

`DiscountAmount` handles both rate types. The result is in the same currency as `listPrice` — the function does not convert between currencies.

| ValueType | How it works |
|---|---|
| `"percent"` | `listPrice × (Value / 100)`. A `Value` of `20` takes 20% off. |
| `"fixed"` | Subtracts `Value` from `listPrice`. Capped at `listPrice` — result is never negative. A `"fixed"` value of `5` means 5 units of whatever currency `listPrice` is in. |

If `listPrice <= 0` or `rate.Value <= 0`, the result is always `0`.

You set `finalPrice` on the order. The package does not touch your order model.

---

## By meta

Every discount has a `meta` JSONB column. The package stores whatever you put there and never interprets it. That is how you attach host-specific flags to a campaign — for example `"autoApply": true` on a voucher so checkout can apply it without the buyer typing a code, or `"showAsLandingBanner": true` so a marketing page can find campaigns to display.

```json
{
  "autoApply": true,
  "showAsLandingBanner": true
}
```

To find discounts that carry a given flag, call `GetDiscountRatesForProductsByMeta`. `MetaContains` is a JSONB containment check: it matches rows whose `meta` includes at least those keys and values.

A typical use is auto-apply at checkout — no code field, just "is there a usable voucher marked auto-apply for these products?":

```go
import "your-module/discount/types"

grouped, err := discount.GetDiscountRatesForProductsByMeta(db, types.DiscountQueryOptions{
    ProductIDs:         []int64{productID},
    DiscountType:       strPtr("voucher"),
    OnlyUsable:         true,   // filters to active, in-window, under-cap discounts
    At:                 time.Now().UTC(),
    MetaContains:       []byte(`{"autoApply":true}`),
    DiscountQueryScope: types.DiscountQueryScopeRestrictedToSingleUserAndGlobal,
    ForUserID:          &userID,  // required for scopes that need a user id
})
if err != nil {
    return err
}
// grouped is []models.DiscountRates — one element per matching discount
```

This returns a **slice** because more than one campaign can have the same flag at the same time. Your code decides which one wins. A common priority rule: prefer user-restricted discounts over global ones (the package does not enforce this — it is your business rule).

```go
var bestRates *discountmodels.DiscountRates
for i := range grouped {
    r := &grouped[i]
    if r.Discount.UserID != nil {
        bestRates = r // user-restricted wins
        break
    }
    if bestRates == nil {
        bestRates = r // fall back to first global
    }
}

if bestRates == nil {
    // nothing to apply — show list price
}
```

---

## Query scopes

When you call `GetDiscountRatesForProductsByMeta`, the package needs to know whose discounts to include. A discount can be **global** (any buyer can use it, `user_id` is null) or **user-restricted** (created for one specific buyer, `user_id` is set). `DiscountQueryScope` is how you tell the query which category to look in.

This matters because at checkout you almost always want to find the best discount for the person standing there — not every discount in the database. Getting the scope wrong means either missing a user-restricted discount that the buyer is entitled to, or leaking another user's private discounts into the results.

| Scope | What it returns | When to use it |
|---|---|---|
| `DiscountQueryScopeRestrictedToSingleUserAndGlobal` | User-restricted discounts for `ForUserID` **plus** all global ones | Default for a logged-in buyer. Gets you everything they could legitimately use. |
| `DiscountQueryScopeGlobal` | Only global discounts | For guests who have no user id. |
| `DiscountQueryScopeRestrictedToSingleUser` | Only discounts restricted to `ForUserID` | Useful when you want to know specifically what was created for this user, ignoring public campaigns. |
| `DiscountQueryScopeRestrictedToMultipleUsers` | Discounts restricted to any of `ForUserIDs` | Admin batch queries — e.g. showing all user-specific discounts for a set of users. |
| `DiscountQueryScopeAll` | Everything | Admin tools only — never use at checkout. |

The scopes that need a user id enforce it:

```go
// This will return ErrDiscountQueryScopeInvalidForUserID
discount.GetDiscountRatesForProductsByMeta(db, types.DiscountQueryOptions{
    ...
    DiscountQueryScope: types.DiscountQueryScopeRestrictedToSingleUserAndGlobal,
    ForUserID:          nil, // ← forgot to set — error returned
})
```

---

## DiscountQueryOptions fields

`DiscountQueryOptions` is the full set of filters available in a meta query. Every field is optional except `ProductIDs` and `MetaContains`.

| Field | Type | Notes |
|---|---|---|
| `ProductIDs` | `[]int64` | The products in the current cart. Only discounts that have a rate for at least one of these are returned. |
| `MetaContains` | `[]byte` | A JSON snippet that must be contained in `discounts.meta`. For example `{"autoApply":true}`. An empty value short-circuits and returns nothing. |
| `DiscountQueryScope` | `DiscountQueryScope` | Whose discounts to include. See the table above. |
| `ForUserID` | `*int64` | Required when scope is `for_user` or `for_user_and_global`. |
| `ForUserIDs` | `[]int64` | Required when scope is `for_multiple_users`. |
| `DiscountType` | `*string` | Filter to `"voucher"` or `"referral"` only. Leave nil to include both. |
| `OnlyUsable` | `bool` | `true` applies the same checks as `IsUsable` in SQL: skips disabled, expired, and exhausted discounts. Set this to `true` at checkout — set it to `false` only in admin tools where you want to see everything. |
| `At` | `time.Time` | The point in time to use for window checks when `OnlyUsable` is true. Defaults to `time.Now().UTC()` when zero. |

::: info `OnlyUsable` vs `IsUsable`
`OnlyUsable: true` filters in SQL — you never see unusable discounts in the returned slice. When you look up by code instead (`GetDiscountRatesForProductsByDiscountCode`), there is no such filter, so you always call `IsUsable` yourself afterward to decide whether to apply the discount.
:::

---

## IsUsable reference

`rates.Discount.IsUsable(at time.Time, forUserID *int64) (bool, error)` returns `false` with a typed error in these cases:

| Condition | Error |
|---|---|
| `Disabled = true` | `ErrDiscountNotUsable` |
| Current time is before `StartDate` | `ErrDiscountNotUsable` |
| Current time is after `EndDate` | `ErrDiscountNotUsable` |
| `UsedCount >= MaxUses` | `ErrDiscountNotUsable` |
| `UserID` is set and `forUserID` does not match | `ErrDiscountNotForUser` |

When `OnlyUsable: true` is set in a meta query, the query builder applies these same checks in SQL — you still call `IsUsable` after a code lookup because that path does not have `OnlyUsable`.
