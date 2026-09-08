---
title: Reference — Discount
description: All function signatures, sentinel errors, types, and table schemas for the discount package.
---

# Reference

Complete function signatures, sentinel errors, model helpers, and table schemas for the `discount` package. For a walkthrough of how to wire the package end to end, start with [Getting started](./).

---

## Engine functions

These are the top-level functions you import from `your-module/discount`.

### CreateDiscountWithProductRates

```go
func CreateDiscountWithProductRates(
    db       *gorm.DB,
    input    types.CreateDiscountInput,
    createdBy *int64,
) (*CreateDiscountResult, error)
```

Creates the discount row and all its rate rows in one transaction. Returns a `*CreateDiscountResult` with `Discount *models.Discount` and `Products []models.DiscountProduct`. Empty `Products` in the input is allowed (creates a discount with no rates).

### GetDiscountRatesForProductsByDiscountCode

```go
func GetDiscountRatesForProductsByDiscountCode(
    db         *gorm.DB,
    code       string,
    productIDs []int64,
) (*models.DiscountRates, error)
```

Looks up a discount by code and returns its rates for the given products. The code is normalized to uppercase before lookup. `productIDs` may be empty — returns all rates for the discount in that case.

Returns `ErrDiscountNotFoundOrNotApplicable` if the code does not exist or has no rates for those products.

### GetDiscountRatesForProductsByMeta

```go
func GetDiscountRatesForProductsByMeta(
    db   *gorm.DB,
    opts types.DiscountQueryOptions,
) ([]models.DiscountRates, error)
```

Returns one `DiscountRates` per matching discount. Empty `MetaContains` returns `nil` without querying. See [Resolving discounts](./resolve#by-meta-e-g-auto-apply) for scope and field details.

### DiscountAmount

```go
func DiscountAmount(
    basePrice          float64,
    discountValueType  models.DiscountProductValueType,
    discountValue      float64,
) float64
```

Returns the amount to subtract from `basePrice`, in the same currency as `basePrice`. Fixed discounts are capped at `basePrice` — the result is never negative. Returns `0` when `basePrice <= 0` or `discountValue <= 0`.

### BuildPaymentDiscountSnapshot

```go
func BuildPaymentDiscountSnapshot(
    paymentID   uuid.UUID,
    orderID     int64,
    productID   int64,
    productName string,
    basePrice   float64,
    d           *models.Discount,
    rate        *models.DiscountProduct,
    currency    string,
) models.PaymentDiscount
```

Builds the snapshot struct from the in-memory discount and rate. Does not write to the database. Insert with `models.CreatePaymentDiscount`. See [Fulfillment & history](./fulfill).

---

## Model helpers

Import `discountmodels "your-module/discount/models"`.

### Discount

| Function | What it does |
|---|---|
| `CreateDiscount(db, input, createdBy)` | Low-level insert (prefer `CreateDiscountWithProductRates`). |
| `UpdateDiscount(db, id, input)` | Partial update using `NullableField`. |
| `DeleteDiscount(db, id)` | Hard delete. Allowed even when `used_count > 0` — snapshots on `payment_discounts` keep the history. Returns `gorm.ErrRecordNotFound` if the id does not exist. |
| `GetDiscountByID(db, id)` | Fetch by UUID. Returns `nil, nil` if not found. |
| `GetDiscountByCode(db, code)` | Fetch by normalized code. Returns `nil, nil` if not found. |
| `IncrementDiscountUsage(db, code)` | Atomically adds 1 to `used_count`. Returns `ErrDiscountNotFound` if the campaign is gone — skip usage, keep the snapshot. |
| `DecrementDiscountUsage(db, code)` | Atomically subtracts 1 (never below 0). |

**Discount methods**

| Method | What it does |
|---|---|
| `d.IsUsable(at, forUserID)` | Returns `(bool, error)`. See [Resolving discounts](./resolve#checking-usability). |
| `d.IsRestrictedToThisUser(userID)` | Returns `true` when `d.UserID` matches. |
| `d.IsReferral()` | Returns `true` when `d.Type == "referral"`. |
| `d.IsVoucher()` | Returns `true` when `d.Type == "voucher"`. |

### DiscountProduct (rates)

| Function | What it does |
|---|---|
| `CreateDiscountProducts(db, discountID, inputs)` | Batch insert rates. |
| `ReplaceDiscountProducts(db, discountID, inputs)` | Delete all existing rates and insert new ones in one transaction. |
| `UpdateDiscountProduct(db, discountID, rateID, input)` | Partial update for one rate. |
| `DeleteDiscountProduct(db, discountID, rateID)` | Delete one rate row. |
| `ListDiscountProductsByDiscountID(db, id)` | All rates for a discount. |

**DiscountRates type**

```go
type DiscountRates struct {
    Discount models.Discount
    Rates    map[int64]models.DiscountProduct // product_id → rate
}

func (dr *DiscountRates) RateForProduct(productID int64) *models.DiscountProduct
```

`RateForProduct` returns `nil` when the product has no rate under this discount.

### PaymentDiscount (snapshots)

| Function | What it does |
|---|---|
| `GetPaymentDiscountsByPaymentID(db, paymentID)` | All product-line snapshots for a payment. |
| `GetPaymentDiscountByPaymentIDAndProductID(db, paymentID, productID)` | One product snapshot. Returns `nil, nil` if not found. |
| `GetPaymentDiscountsByOrderID(db, orderID)` | All snapshots across all payments for an order. |
| `GetPaymentDiscountByID(db, id)` | Load by UUID. Returns `nil, nil` if not found. |
| `CreatePaymentDiscount(db, pd)` | Insert a snapshot. Unique on `(payment_id, product_id)`. Build `pd` with `BuildPaymentDiscountSnapshot`. |

---

## Sentinel errors

All live under `discount/validations`. Import as `discountvalidations "your-module/discount/validations"` and compare with `errors.Is`.

```go
if errors.Is(err, discountvalidations.ErrDiscountCodeDuplicate) { ... }
```

| Error | When you see it |
|---|---|
| `ErrDiscountCodeDuplicate` | Code already exists in `discounts` |
| `ErrDiscountCodeRequired` | Empty or whitespace-only code |
| `ErrDiscountTypeInvalid` | Type is not `"voucher"` or `"referral"` |
| `ErrDiscountDateRangeInvalid` | `EndDate` ≤ `StartDate` |
| `ErrDiscountEndDateMustBeFuture` | `EndDate` is in the past |
| `ErrDiscountVoucherShapeInvalid` | Voucher type with `ReferralID` set |
| `ErrDiscountReferralShapeInvalid` | Referral type without `ReferralID` |
| `ErrDiscountMaxUsesInvalid` | `MaxUses` set to `<= 0` |
| `ErrDiscountUserRestrictedMaxUses` | User-restricted with `MaxUses != 1` |
| `ErrDiscountUserNotFound` | `UserID` references a non-existent user |
| `ErrDiscountReferralNotFound` | `ReferralID` references a non-existent referral |
| `ErrDiscountProductValueTypeInvalid` | `ValueType` is not `"percent"` or `"fixed"` |
| `ErrDiscountProductValueInvalid` | Value out of range for its type |
| `ErrDiscountProductDuplicateRate` | Two rates for the same `ProductID` |
| `ErrDiscountProductNotFound` | `ProductID` references a non-existent product |
| `ErrDiscountNotFound` | No discount with that id or code |
| `ErrDiscountNotFoundOrNotApplicable` | Code exists but has no rates for these products |
| `ErrDiscountNotUsable` | Disabled, outside window, or cap exhausted |
| `ErrDiscountNotForUser` | Restricted to a different user |
| `ErrDiscountQueryScopeInvalidForUserID` | Scope needs `ForUserID` but it is nil |
| `ErrDiscountQueryScopeInvalidForUserIDs` | Scope needs `ForUserIDs` but it is empty |

---

## Input types

```go
// discount/types
type CreateDiscountInput struct {
    Type        string
    Code        string
    Description string
    StartDate   time.Time
    EndDate     *time.Time
    MaxUses     *int
    Disabled    *bool
    UserID      *int64
    ReferralID  *int64
    Meta        datatypes.JSON
    Products    []DiscountProductInput
}

type DiscountProductInput struct {
    ProductID int64
    ValueType string  // "percent" or "fixed"
    Value     float64
}

type UpdateDiscountInput struct {
    Type        *NullableField[string]
    Code        *NullableField[string]   // immutable — rejected on update
    Description *NullableField[string]
    StartDate   *NullableField[time.Time]
    EndDate     *NullableField[time.Time]
    MaxUses     *NullableField[int]
    Disabled    *NullableField[bool]
    UserID      *NullableField[int64]
    ReferralID  *NullableField[int64]
    Meta        *NullableField[datatypes.JSON]
}

type UpdateDiscountProductInput struct {
    ValueType *NullableField[string]
    Value     *NullableField[float64]
}

// NullableField distinguishes "leave unchanged" (nil outer pointer) from
// "set to null" (non-nil outer pointer, nil inner Value).
type NullableField[T any] struct {
    Value *T
}

type DiscountQueryOptions struct {
    ProductIDs         []int64
    DiscountType       *string
    OnlyUsable         bool
    At                 time.Time
    MetaContains       []byte
    DiscountQueryScope DiscountQueryScope
    ForUserID          *int64
    ForUserIDs         []int64
}

type DiscountQueryScope string

const (
    DiscountQueryScopeRestrictedToSingleUser          DiscountQueryScope = "for_user"
    DiscountQueryScopeRestrictedToSingleUserAndGlobal DiscountQueryScope = "for_user_and_global"
    DiscountQueryScopeRestrictedToMultipleUsers       DiscountQueryScope = "for_multiple_users"
    DiscountQueryScopeGlobal                          DiscountQueryScope = "global"
    DiscountQueryScopeAll                             DiscountQueryScope = "all"
)
```

---

## Tables {#tables}

```
users (host)     referrals (host)     products (host)
   ▲                  ▲                    ▲
   │                  │ referral_id FK      │ product_id FK
   │ created_by /     │                    │
   │ user_id FKs      │              discount_products
   │                  │                    │
   └──────────────── discounts ────────────┘

payment_discounts   (no FKs — immutable copied values only)
```

### discounts

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, auto-generated |
| `type` | varchar | `"voucher"` or `"referral"` |
| `code` | varchar | Unique, uppercase-normalized |
| `description` | text | Optional free text |
| `start_date` | timestamptz | When the discount becomes active |
| `end_date` | timestamptz | Optional expiry |
| `max_uses` | int | Optional cap; `null` = unlimited |
| `used_count` | int | Incremented atomically by fulfill; never decremented below 0 |
| `disabled` | bool | `true` deactivates immediately |
| `user_id` | bigint | FK → `users`. `null` = global |
| `referral_id` | bigint | FK → `referrals`. Required for referral type |
| `meta` | jsonb | Free storage; package never reads it |
| `created_by` | bigint | FK → `users` (SET NULL on user delete) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### discount_products

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `discount_id` | uuid | FK → `discounts` ON DELETE CASCADE |
| `product_id` | bigint | FK → `products` ON DELETE RESTRICT |
| `value_type` | varchar | `"percent"` or `"fixed"` |
| `value` | float | The rate amount |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Unique index on `(discount_id, product_id)` — one rate per product per discount.

### payment_discounts

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `payment_id` | uuid | Copied value — **no FK** |
| `order_id` | bigint | Copied value — **no FK** |
| `discount_type` | varchar | Snapshot of `discounts.type` |
| `product_id` | bigint | Copied value — **no FK** |
| `product_name` | varchar | Snapshot of product name at checkout |
| `discount_description` | text | Snapshot of campaign description |
| `discount_code` | varchar | Snapshot of the code |
| `referral_id` | bigint | Copied from discount; no FK |
| `meta` | jsonb | Reserved (currently always null) |
| `value_type` | varchar | Snapshot of rate type |
| `value` | float | Snapshot of rate amount |
| `base_amount` | float | List price at checkout, rounded |
| `discounted_amount` | float | Amount taken off, rounded |
| `currency` | varchar(3) | Checkout currency (ISO 4217). Empty string at fulfill time falls back to `"USD"`. |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Unique index on `(payment_id, product_id)` — one snapshot per product per payment.
