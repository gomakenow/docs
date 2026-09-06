---
title: Reference — Payment
description: Gateway interface, sentinel errors, model helpers, and table schemas.
---

# Reference

Complete function signatures, sentinel errors, model helpers, and table schemas for the `payment` package. For a walkthrough of how to wire the package end to end, start with [Getting started](./).

---

## Building the Gateway

```go
func NewDefaultGateway() *DefaultGateway
```

Constructs the built-in implementation with all four providers wired (Stripe, Lemon Squeezy, NowPayments, wallet). The return type satisfies `payment.Gateway`, so you can assign it to the interface. Call it once in `main.go`.

```go
type Gateway interface {
    Create(ctx context.Context, db *gorm.DB, in paymentProviders.CreateInput) (*paymentmodel.Payment, error)
    CreateFree(db *gorm.DB, in paymentProviders.CreateFreeInput) (*paymentmodel.Payment, error)
    SyncStatus(ctx context.Context, db *gorm.DB, pay *paymentmodel.Payment) (*paymentmodel.Payment, error)
    MapStatus(provider paymentconfigs.PaymentProvider, rawStatus string) (markPaid bool, mapped paymentconfigs.PaymentStatus, err error)
    BatchWalletPaidStatus(ctx context.Context, orderIDs []string) (map[string]bool, error)
    SyncProducts(ctx context.Context, db *gorm.DB, provider paymentconfigs.PaymentProvider, products []paymentProviders.SyncProductInput) ([]paymentProviders.SyncProductResult, error)
    SupportsRefund(provider paymentconfigs.PaymentProvider) bool
    Refund(ctx context.Context, db *gorm.DB, pay *paymentmodel.Payment, in paymentProviders.RefundInput) (*paymentmodel.PaymentRefund, error)
}
```

Notes:

- `Create` accepts only `"card"` or `"crypto"` as `Method`. Unknown provider or method returns an error. Zero-price checkouts use `CreateFree`.
- `CreateFree` requires `OrderID`. Empty `Currency` becomes `"USD"`. A second call for the same order returns the existing free row.
- `MapStatus` does not authenticate the source — only use it after `Process` or a verified provider API call.
- `SupportsRefund` is a type assertion — it returns `true` when the wired provider implements `providers.Refunder`. `Provider_Free` is never a refunder.

### CreateFreeInput

```go
type CreateFreeInput struct {
    OrderID     int64
    Currency    string
    ProductType *string
}
```

| Field | Required | Description |
|---|---|---|
| `OrderID` | yes | Your `orders.id`. Stored as `payments.order_id`. |
| `Currency` | no | ISO fiat code. Empty → `"USD"`. |
| `ProductType` | no | Tag stored on `payments.product_type`. |

---

## Webhook processing

```go
func Process(ctx context.Context, provider paymentconfigs.PaymentProvider, in Input) (*Event, error)

type Input struct {
    Headers http.Header
    Body    []byte         // raw, unmodified request body
    Gateway payment.Gateway // nil → NewDefaultGateway()
}

func (e *Event) IsRefund() bool
```

Possible errors: `webhook.ErrUnauthorized`, `webhook.ErrBadRequest`, `webhook.ErrNotConfigured`, `webhook.ErrUnsupported`.

---

## Sentinel errors

All live under `paymenterrors`:

```go
ErrProviderNotConfigured  // provider env vars are missing
ErrProviderUnavailable    // provider disabled at checkout (usually set by host code)
ErrCatalogSync            // catalog product creation or rename failed
ErrCheckoutCreate         // provider rejected the checkout session
ErrRefundNotSupported     // provider does not support refunds
ErrRefundFailed           // provider refund call failed
ErrRefundInProgress       // a pending refund already exists for this payment
ErrAlreadyRefunded        // a succeeded refund already exists for this payment
```

Provider implementations wrap with `fmt.Errorf("%w: %w", paymenterrors.ErrCatalogSync, causeErr)`, so `errors.Is` works through the chain.

```go
func PublicCheckoutMessage(err error) string
```

Maps sentinel errors to short, safe browser messages. Strips Stripe error strings and SQL details that should not reach users.

---

## Constants

**Providers** (`paymentconfigs`): `Provider_Stripe` (`"stripe"`), `Provider_LemonSqueezy` (`"lemon_squeezy"`), `Provider_NowPayments` (`"now_payments"`), `Provider_UserWallet` (`"user_wallet"`), `Provider_Free` (`"free"`).

**Methods**: `Method_Card` (`"card"`), `Method_Crypto` (`"crypto"`), `Method_Free` (`"free"`).

**Payment statuses**: `pending`, `confirming`, `partially_paid`, `paid`, `failed`, `expired`, `cancelled`.

**Refund statuses**: `pending`, `succeeded`, `failed`.

**Timeouts**: `HTTPClientTimeout` = 20s. `WalletHealthTimeout` = 3s.

**Placeholder**: `providers.PaymentIDPlaceholder` = `"{payment_id}"`.

---

## Model helpers

**Payments**

| Function | What it does |
|---|---|
| `GetPaymentByID(db, id)` | Load by UUID. Attaches `pay.LatestRefund`. |
| `GetPaymentByProviderPaymentID(db, provider, id)` | Load by provider's own id. |
| `FindNewestPaymentByOrderID(db, orderID)` | Most recent attempt for an order. |
| `FindOldestPaidPaymentByOrderID(db, orderID)` | Oldest paid attempt — useful for fulfillment. |
| `FindInProgressPayment(db, query)` | Find pending/confirming/partially_paid rows. |
| `OrderHasSettledPayment(db, orderID)` | Quick boolean check. |
| `SumPaidValueByOrderID(db, orderID)` | Total collected across all paid attempts. |
| `MarkPaid(db, paidValue, paidAt)` | Terminal success. |
| `MarkExpired(db)` | Window closed. |
| `MarkCancelled(db)` | Host or reuse logic cancelled. |
| `GatewayReferenceID()` | `payments.id` as a string — what was sent to the provider as `order_id`. |

**Refunds**

| Function | What it does |
|---|---|
| `UpsertRefund(...)` | Insert or update a refund row. Use this for inbound webhook refunds. |
| `MarkRefundSucceeded(db, row)` | Mark a local refund as succeeded without calling the provider. |
| `ListRefundsByPaymentID(db, id)` | All refunds for a payment. |
| `ListRefundsByOrderID(db, id)` | All refunds across all payments for an order. |
| `LatestSucceededRefund(db, paymentID)` | Newest succeeded row. |
| `LatestPendingRefund(db, paymentID)` | Newest pending row. |
| `GetRefundByProviderRefundID(db, provider, id)` | Look up by provider's refund id. |

**Catalog**

| Function | What it does |
|---|---|
| `GetGatewayProductByProductID(db, id)` | Load the catalog link for a product. |
| `ListGatewayProductsByProductIDs(db, ids)` | Batch load catalog links. |
| `SetStripeProductID(db, productID, stripeID)` | Write the provider catalog id. |
| `SetProductName(db, productID, name)` | Update the stored product name. |

---

## Tables {#tables}

```
orders (host)              products (host)
   ▲                          ▲
   │ order_id FK              │ product_id FK
   │                          │
payments  ◄── payment_id ── payment_refunds
   │
   └── catalog links in gateway_products (product_id → products)
```

Host FKs assume bigint `orders.id` and `products.id`. Edit the published SQL before applying if your primary keys are UUIDs.

### payments

Rows are **not** deleted on success. The table is permanent collection history.

| Column | Notes |
|---|---|
| `id` | UUID PK. Sent to providers as `order_id`. |
| `order_id` | FK → `orders`. |
| `provider` / `payment_method` | Snake_case provider key; `"card"` or `"crypto"`. |
| `status` | Collection lifecycle — see [Collection statuses](./create#collection-statuses). |
| `amount` / `currency` | Requested amount and fiat code. |
| `provider_payment_id` / `provider_invoice_id` | Provider-side reference ids. |
| `invoice_url` | Hosted checkout URL (Stripe, LS, NowPayments). |
| `wallet_address` / `network` / `asset` | On-chain deposit info. `asset` is validated as USDT or USDC. |
| `product_type` | Host tag. Package never reads it. |
| `paid_value` / `paid_at` | Collected amount and timestamp on success. |
| `on_chain_balance` | Unswept on-chain value (wallet). |
| `expired_at` | When the attempt window closes. |
| `swept_at` / `swept_by` | Treasury sweep info (wallet). |

### payment_refunds

| Column | Notes |
|---|---|
| `id` | UUID PK. |
| `payment_id` | FK → `payments` **ON DELETE RESTRICT** — you cannot delete a payment that has a refund row. |
| `order_id` | Copied from the payment at write time. FK → `orders`. |
| `provider` | Same snake_case key as the payment. |
| `provider_refund_id` | Provider's refund id (`re_*` for Stripe). Unique per provider when set. |
| `amount` / `currency` | Refund amount and currency. |
| `status` | `pending`, `succeeded`, or `failed`. |
| `reason` / `failure_reason` | Host reason and provider failure message. |

### gateway_products

| Column | Notes |
|---|---|
| `product_id` | FK → `products` **ON DELETE CASCADE**. |
| `stripe_product_id` | Provider catalog id (`prod_…` for Stripe). Empty until synced. |
| `product_name` | Last name successfully pushed. Used to skip network calls when nothing changed. |
