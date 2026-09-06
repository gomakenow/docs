---
title: Testing — Payment
description: In-memory SQLite helpers and mocks for payment package tests.
---

# Testing

The `payment/testutil` package — import it as `paytest` — gives you an isolated SQLite database with the payment-owned tables already created. Package tests run without a host Postgres, without `backend/db`, and without any of the provider SDKs. They must not call live Stripe, Lemon Squeezy, NowPayments, or the wallet microservice.

Host application tests that exercise checkout handlers are different. Those keep your Postgres, use transaction rollback for isolation, and seed real orders. Inject a fake `payment.Gateway` the same way production injects `NewDefaultGateway()`. The fake must implement `CreateFree` as well as `Create` — a simple approach is to delegate `CreateFree` to `payment.NewDefaultGateway().CreateFree(db, in)` so zero-price tests still persist a real row.

---

## paytest.OpenTestDB

```go
db := paytest.OpenTestDB(t)
```

Opens an in-memory SQLite database named after `t.Name()` and runs the payment migrations against it — creating `payments`, `payment_refunds`, and `gateway_products`. The connection is closed via `t.Cleanup` so you never need to close it yourself. Parallel tests each get their own database, so rows never bleed between tests.

There is no `orders` or `products` table here. `payments.order_id` is an opaque `int64`. That is intentional — the package does not know your order model, so tests should not need it either.

---

## paytest.SeedTestOrder

```go
order, sub := paytest.SeedTestOrder()
```

Returns an `*OrderInput` and a `*SubOrderInput` pre-filled with a unique `ID` / `ProductID` and `Price: 49`. Nothing is inserted into a host orders table — there isn't one. Pass these directly into `gw.Create` (with a test provider that points at a fake HTTP server).

For a zero-price row there is no HTTP to mock. Point `CreateFree` at `paytest.OpenTestDB` and assert the returned row is `paid` with `provider = free`:

```go
db := paytest.OpenTestDB(t)
pay, err := payment.NewDefaultGateway().CreateFree(db, paymentProviders.CreateFreeInput{
    OrderID: 42,
})
```

---

## Mocking providers

Package tests aim a provider at a local `httptest.Server` instead of the live API:

```go
// Construct a Stripe provider that calls your test server instead of api.stripe.com
provider := NewStripeProviderForTest(testServer.URL)
```

Similar constructors exist for Lemon Squeezy (`NewLemonSqueezyProviderForTest`) and NowPayments (`NewNowPaymentsProviderForTest`). The wallet has its own `paytest` mock helpers that spin up an `httptest.Server` returning controlled JSON responses.

Each provider has a matching `mock_*.go` file in `paytest` with pre-built response bodies you can configure per-test. For secrets and API keys in tests, use the env override helpers in `testutil/env.go` — they scope the override to the current test and restore original values via `t.Cleanup`, so parallel tests do not interfere.

### Testing webhooks

Build a properly signed `paymentWebhook.Input` with the helpers in `payment/webhook/webhook_test_helpers.go`. They compute the correct HMAC for you — you just pass a test secret and a body. Then verify that:

- `Process` returns `webhook.ErrUnauthorized` when the signature is wrong or missing.
- `Process` returns a populated `*Event` when the signature is correct.

---

## Seeding in-progress rows

To test the reuse logic in `Create` without a first HTTP round-trip, seed an in-progress payment directly:

```go
id := paytest.SeedNowpaymentsInProgressPayment(t, db, order, invoiceID, invoiceURL)

// Simulate funds already arriving (for the "price changed, funds on the way" branch)
paytest.UpdatePaymentFields(t, db, id, map[string]interface{}{"paid_value": 10.0})
```

Similar helpers exist for wallet, Stripe, and Lemon Squeezy — `SeedWalletInProgressPayment`, `SeedStripeInProgressPayment`, and so on.

---

## Running package tests

```sh
# All payment package tests
make -C backend/payment test-payment

# A specific test
make -C backend/payment test-payment TestStripeProvider_Create
```

These do not need `GO_TEST=1` or the host `.env.test` Postgres. Host checkout and fulfillment tests live in `backend/handlers` and `backend/services` — those use the full Postgres stack and follow the backend tests guide.
