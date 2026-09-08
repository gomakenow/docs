---
title: Testing — Discount
description: In-memory SQLite helpers for package tests. No host Postgres needed.
---

# Testing

The `discount/testutil` package — import it as `distest` — gives you an isolated in-memory SQLite database with all three discount-owned tables already created, plus tiny stub `products` and `orders` tables so FK checks still work. Package tests run without a host Postgres, without `backend/db`, and without touching a live database.

Host application tests (handlers, services) that exercise checkout with discounts are different. Those keep your Postgres, use transaction rollback for isolation, and inject a real `*gorm.DB`. Package tests use `distest` exclusively.

---

## distest.OpenTestDB

```go
import distest "your-module/discount/testutil"

db := distest.OpenTestDB(t)
```

Opens an in-memory SQLite database named after `t.Name()` and creates all the discount tables — `discounts`, `discount_products`, `payment_discounts` — plus stub `products (id)` and `orders (id)` tables with two seeded product rows (`id = 1` and `id = 2`).

The connection is registered via `t.Cleanup` and closes automatically when the test ends. Parallel tests each get their own separate in-memory database, so rows never bleed between tests.

The stub tables are minimal on purpose. The discount package only knows the `int64` ids you pass in — it does not know your real product or order model. The stubs satisfy the FK constraints without needing your full schema.

---

## Seed helpers

These return unique, incrementing ids so tests never collide even when run in parallel.

```go
// Unique user id
userID := distest.NextUserID()  // int64

// Unique referral id
refID := distest.NextReferralID()  // int64

// Unique order id — does NOT insert a DB row
orderID := distest.NextOrderID()  // int64

// Unique order id — inserts a stub orders row and returns its id.
// Use this when a test DELETEs from orders to prove payment_discounts survives.
orderID = distest.SeedOrder(t, db)

// The two pre-seeded product ids (always available in the db)
productID  := distest.CatalogProductID       // int64 = 1
productID2 := distest.CatalogSecondProductID // int64 = 2

// Convenience
ids        := distest.ProductIDs() // []int64{1, 2}
```

---

## Writing a test

Here is a complete example — create a discount, resolve it, freeze a snapshot, then increment usage:

```go
func TestDiscountSnapshotAndUsage(t *testing.T) {
    db     := distest.OpenTestDB(t)
    userID := distest.NextUserID()

    // 1. Create a campaign
    result, err := discount.CreateDiscountWithProductRates(db, types.CreateDiscountInput{
        Type:      "voucher",
        Code:      "TEST20",
        StartDate: time.Now().UTC().Add(-time.Hour),
        Products: []types.DiscountProductInput{
            {ProductID: distest.CatalogProductID, ValueType: "percent", Value: 20},
        },
    }, nil)
    require.NoError(t, err)
    require.NotNil(t, result.Discount)

    // 2. Resolve at checkout
    rates, err := discount.GetDiscountRatesForProductsByDiscountCode(db, "TEST20", []int64{distest.CatalogProductID})
    require.NoError(t, err)

    usable, err := rates.Discount.IsUsable(time.Now().UTC(), &userID)
    require.True(t, usable)
    require.NoError(t, err)

    rate := rates.RateForProduct(distest.CatalogProductID)
    require.NotNil(t, rate)

    discountAmt := discount.DiscountAmount(49.0, rate.ValueType, rate.Value)
    assert.Equal(t, 9.80, discountAmt)

    // 3. Freeze snapshot when the payment is created
    paymentID := uuid.New()
    orderID   := distest.NextOrderID()

    snapshot, err := discountmodels.CreatePaymentDiscount(db, discount.BuildPaymentDiscountSnapshot(
        paymentID, orderID,
        distest.CatalogProductID, "Pro Plan", 49.0,
        result.Discount, rate, "EUR",
    ))
    require.NoError(t, err)
    require.NotNil(t, snapshot)
    assert.Equal(t, "TEST20", snapshot.DiscountCode)
    assert.Equal(t, 49.0, snapshot.BaseAmount)
    assert.Equal(t, 9.80, snapshot.DiscountedAmount)

    // 4. Increment usage when the payment succeeds
    require.NoError(t, discountmodels.IncrementDiscountUsage(db, snapshot.DiscountCode))

    d, err := discountmodels.GetDiscountByID(db, result.Discount.ID)
    require.NoError(t, err)
    assert.Equal(t, 1, d.UsedCount)
}
```

---

## Testing usability

`IsUsable` is a method on the in-memory `Discount` struct — no database call. Pass a specific `time.Time` to test window behaviour:

```go
// Expired discount
d := models.Discount{
    Disabled:  false,
    StartDate: time.Now().Add(-48 * time.Hour),
    EndDate:   timePtr(time.Now().Add(-1 * time.Hour)), // already past
    UsedCount: 0,
}
usable, err := d.IsUsable(time.Now(), nil)
assert.False(t, usable)
assert.ErrorIs(t, err, discountvalidations.ErrDiscountNotUsable)
```

---

## Testing errors

```go
import discountvalidations "your-module/discount/validations"

// Duplicate code
_, err := discount.CreateDiscountWithProductRates(db, types.CreateDiscountInput{
    Type: "voucher", Code: "DUPE", StartDate: time.Now(),
    Products: []types.DiscountProductInput{{...}},
}, nil)
require.NoError(t, err)

_, err = discount.CreateDiscountWithProductRates(db, types.CreateDiscountInput{
    Type: "voucher", Code: "DUPE", StartDate: time.Now(),
    Products: []types.DiscountProductInput{{...}},
}, nil)
require.ErrorIs(t, err, discountvalidations.ErrDiscountCodeDuplicate)
```

---

## Testing the snapshot survives deletion

A key invariant: deleting the campaign or the product does not remove `payment_discounts` rows. Write a test for this if you are adding logic that depends on it:

```go
orderID := distest.SeedOrder(t, db)
// ... create discount, fulfill ...

// Delete the live campaign — even after it has been used.
// payment_discounts has no FK, so snapshots stay.
err = discountmodels.DeleteDiscount(db, discountID)
require.NoError(t, err)

// Snapshots still there
snapshots, err := discountmodels.GetPaymentDiscountsByPaymentID(db, paymentID)
require.NoError(t, err)
assert.Len(t, snapshots, 1)
```

---

## Running package tests

```sh
# All discount package tests
make -C backend/discount test-discount

# One test by name
make -C backend/discount test-discount TestDiscountFulfillment
```

These do not need `GO_TEST=1` or the host `.env.test` Postgres. Host tests that exercise checkout handlers with real discounts live in `backend/handlers` and `backend/services` — those use the full Postgres stack and follow the [backend tests guide](/packages/backend-tests).
