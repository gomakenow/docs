---
title: Creating payments — Payment
description: Every CreateInput field, CreateFree, reuse rules, SyncStatus, and collection statuses.
---

# Creating payments

[Getting started](./) showed a minimal `gw.Create` call to get something running fast. This page covers everything else: what each field in `CreateInput` actually does, what the returned `Payment` row contains, what happens if the buyer clicks Pay twice, how to poll when a webhook is late, how to record a zero-price checkout with `CreateFree`, and the full list of statuses a payment can go through. Catalog sync and refunds have their own pages.

---

## How Create works

When you call `gw.Create`, the Gateway first checks that you passed a valid `Method` and `Provider` and that `Order` and `SubOrder` are not nil. If credentials for that provider are missing — for example, you passed `Provider_Stripe` but `STRIPE_SECRET_KEY` is empty — it returns `ErrProviderNotConfigured` right there, before any network call.

Then it checks whether there is already an in-progress payment for this order on this provider. This is the reuse logic — if the buyer clicked Pay twice, you should not end up with two open Stripe sessions. See [Reuse](#reuse) below for the full rules.

If nothing is in progress, it calls the provider API to create a Checkout Session, invoice, or deposit address — and inserts a `payments` row with `status = pending`. That is what you get back.

The buyer's money has not moved yet. `Create` only opens the attempt.

---

## Building CreateInput

`CreateInput` is not your GORM `Order` model. It is a small, payment-specific struct that contains only the fields the package needs to call the provider and write the row. You copy the relevant values from your own models.

### Order and SubOrder

Every `Create` call requires two nested structs: `Order` (who is paying and how much) and `SubOrder` (what they are buying).

**`Order`** carries three fields:

- `ID` — your `orders.id`. This gets stored as `payments.order_id` so you can always find a payment by order.
- `UserID` — your user's id. It is copied into provider metadata where the API supports it (for example, Stripe customer metadata). The package never queries your `users` table.
- `Price` — the amount to collect, as a float. This is stored as `payments.amount`.

**`SubOrder`** carries two:

- `ProductID` — your catalog product id. Catalog-backed providers use this as the key when linking to their own product object in `gateway_products`. See [Catalog sync](./catalog).
- `Name` — the product name shown on the hosted checkout page or invoice. You control the wording. The package does not add branding.

### Method and Provider

`Method` is either `paymentconfigs.Method_Card` (`"card"`) or `Method_Crypto` (`"crypto"`). Anything else is an error before the provider is even called.

`Provider` controls which rail handles the checkout:

| Constant | String value | Method |
|---|---|---|
| `Provider_Stripe` | `stripe` | card |
| `Provider_LemonSqueezy` | `lemon_squeezy` | card |
| `Provider_NowPayments` | `now_payments` | crypto |
| `Provider_UserWallet` | `user_wallet` | crypto |

`Provider_Free` (`"free"`) is for zero-price rows created with `CreateFree`. `Create` does not route it — see [Zero-price checkouts](#zero-price--free) below.

### Redirect URLs

`SuccessURL`, `CancelURL`, and `NotificationURL` are all URLs **you** own. The package never reads `APP_URL` — you pass these explicitly.

The token `{payment_id}` in any of these URLs is replaced with the new `payments.id` UUID before the row is inserted. That way your success page knows which payment to look up without needing to pass the id through session state.

- **`SuccessURL`** — where the browser lands after a successful payment. Used by Stripe, Lemon Squeezy, and NowPayments.
- **`CancelURL`** — where the browser goes when the buyer abandons checkout. NowPayments only.
- **`NotificationURL`** — the provider-to-host IPN URL for NowPayments. This is your webhook route for that provider specifically.

For the wallet provider, the webhook URL is not on `CreateInput` at all — it is configured on the wallet microservice itself via `WalletAdmin.UpdateSettings`.

### Optional fields

**`Currency`** — ISO fiat code for the price, e.g. `"USD"` or `"EUR"`. Empty defaults to `"USD"`. Note that Lemon Squeezy uses your store's configured currency and wallet deposits are always USDT-denominated — both ignore an arbitrary code you pass here.

**`BuyerEmail`** — prefills the email field on the hosted checkout page. Load it from your `users` table. The package never queries `users` itself.

**`Description`** — invoice copy shown to the buyer (NowPayments). Empty falls back to `SubOrder.Name`.

**`ProductType`** — an optional string tag stored on `payments.product_type`, like `"license"` or `"credits"`. The package never interprets it. Use it in your fulfillment handler to decide what to grant after the payment succeeds.

**`Network` / `Asset`** — wallet provider only. The blockchain network (`"tron"`) and token (`"USDT"`) the buyer should deposit to. Ignored by card providers entirely. The schema validates that `asset` is `USDT` or `USDC` when set.

**`CatalogIdempotencyKeyPrefix`** — when Stripe lazily creates a catalog product during `Create`, this scopes the idempotency key. Pass a short project-specific prefix like `"myapp"` so the key becomes `myapp-prod-42` instead of `prod-42`. Two apps sharing one Stripe account must use different prefixes or they will collide. Empty falls back to `prod-{id}`. See [Catalog sync](./catalog#idempotency-prefixes--why-they-matter).

### Putting it all together

Here is a complete `CreateInput` for a Stripe card checkout:

```go
pay, err := gw.Create(ctx, db, paymentProviders.CreateInput{
    Order: &paymentmodel.OrderInput{
        ID:     order.ID,
        UserID: order.UserID,
        Price:  order.Price,
    },
    SubOrder: &paymentmodel.SubOrderInput{
        ProductID: product.ID,
        Name:      product.Name,
    },
    Method:                      paymentconfigs.Method_Card,
    Provider:                    paymentconfigs.Provider_Stripe,
    Currency:                    "USD",
    SuccessURL:                  "https://example.com/pay/success?payment_id={payment_id}",
    BuyerEmail:                  user.Email,
    CatalogIdempotencyKeyPrefix: "myapp",
})
```

For a wallet checkout, swap the provider and add network details:

```go
pay, err := gw.Create(ctx, db, paymentProviders.CreateInput{
    Order: &paymentmodel.OrderInput{
        ID:     order.ID,
        UserID: order.UserID,
        Price:  order.Price,
    },
    SubOrder: &paymentmodel.SubOrderInput{
        ProductID: product.ID,
        Name:      product.Name,
    },
    Method:      paymentconfigs.Method_Crypto,
    Provider:    paymentconfigs.Provider_UserWallet,
    Network:     ptrString("tron"),
    Asset:       ptrString("USDT"),
    SuccessURL:  "https://example.com/pay/success?payment_id={payment_id}",
    BuyerEmail:  user.Email,
})
```

---

## What you get back

`gw.Create` returns `*paymentmodel.Payment`. The fields you will use most:

**`pay.ID`** — the UUID that identifies this payment attempt. This is what you redirect to, what the provider stores as `order_id`, and what webhooks come back referencing via `Event.PaymentID`. Keep it — everything downstream traces back to it.

**`pay.InvoiceURL`** — the hosted checkout URL. For Stripe, Lemon Squeezy, and NowPayments, redirect the browser here. For the wallet provider, there is no redirect — you display `pay.WalletAddress`, `pay.Network`, and `pay.Asset` on your own page instead.

**`pay.Status`** — starts as `pending`. See [Collection statuses](#collection-statuses) below.

**`pay.OrderID`** — your `orders.id`, echoed back.

**`pay.Amount` / `pay.Currency`** — a snapshot of what was requested. Useful for displaying in the UI.

**`pay.ProviderPaymentID` / `pay.ProviderInvoiceID`** — the provider's own reference ids (Stripe PaymentIntent id, Stripe Session id, NowPayments invoice id). The package uses these internally for `SyncStatus` and some webhooks.

**`pay.ExpiredAt`** — when the payment window closes, for wallet and NowPayments.

`pay.GatewayReferenceID()` returns `payments.id` as a string — exactly what was sent to the provider as `order_id`.

---

## Reuse — what happens if the buyer clicks Pay twice {#reuse}

Say the buyer hits your checkout button, lands on Stripe's hosted page, then navigates back and clicks the button again. Without a rule, you would open two separate Checkout Sessions for the same order.

The package handles this. Before calling the provider API, each `Create` looks for an existing `pending`, `confirming`, or `partially_paid` payment for that order on the same provider. Then one of three things happens:

- **Same price (within $0.005)** — the existing row is returned. `SyncStatus` is called first so you never hand back a session that has already succeeded. If it is still in progress, that is what `Create` returns.
- **Price changed, still pending, no funds arrived** — the old attempt is cancelled. Stripe also has its Checkout Session expired via the API (best effort). Then a fresh attempt is created.
- **Price changed, but funds already on their way** — if `paid_value` or `on_chain_balance` is greater than zero, the old row is left completely alone. A new attempt is opened alongside it. You must not void money that is already in flight.

Wallet adds one more condition: the same `Network` and `Asset` must also match to reuse. Switching from Tron USDT to Ethereum USDC always opens a new deposit address.

You do not write any of this logic. Always call `Create` — the provider applies the rule.

---

## SyncStatus — what to do when a webhook never arrives

Sometimes a webhook is lost. The provider was down, your server was restarting, the URL was misconfigured. The buyer paid, you never found out.

`gw.SyncStatus(ctx, db, pay)` asks the provider directly for the current state of `pay` and updates the row. If the payment is already `paid`, it skips the network call entirely and just returns the same row.

```go
pay, err = gw.SyncStatus(ctx, db, pay)
```

Good places to call this: an admin "Refresh payment" button, a background job that sweeps rows stuck in `pending` for too long, or from `Create` itself on the reuse path.

`MapStatus` is a lower-level helper that converts a raw provider status string like `"finished"` or `"complete"` into a canonical `PaymentStatus`. It does not authenticate anything — only call it after you have already verified the source either through `paymentWebhook.Process` or through your own authenticated provider API call.

---

## Collection statuses

Every `payments` row has a `status` column that tracks the collection lifecycle.

| Status | What it means |
|---|---|
| `pending` | The attempt is open. The buyer has not completed payment yet. |
| `confirming` | The provider is waiting for blockchain confirmations. Crypto only. |
| `partially_paid` | Some on-chain value has arrived, but not the full amount. |
| `paid` | Terminal success. This is where you fulfill the order. |
| `failed` | The provider reported a failure. |
| `expired` | The payment window closed before the buyer paid. |
| `cancelled` | The host or the reuse logic cancelled an unfunded attempt. |

Helpers on the row: `IsPaid()`, `IsInProgress()`, `IsPending()`, `MarkPaid(db, paidValue, paidAt)`, `MarkExpired(db)`, `MarkCancelled(db)`.

---

## Looking up payments

```go
// The most common lookup. Also attaches pay.LatestRefund (the newest refund row, if any).
pay, err := paymentmodel.GetPaymentByID(db, paymentID)

// Useful in webhooks when the provider gives you their own id, not yours.
pay, err = paymentmodel.GetPaymentByProviderPaymentID(db, provider, providerPaymentID)

// Admin: find the most recent or the oldest paid attempt for an order.
pay, err = paymentmodel.FindNewestPaymentByOrderID(db, orderID)
pay, err = paymentmodel.FindOldestPaidPaymentByOrderID(db, orderID)

// For the reuse and polling logic internally, or from admin jobs.
inProgress, err := paymentmodel.FindInProgressPayment(db, query)
```

---

## Which provider to use

This is a host decision. The package does not read a settings table. A typical pattern:

1. Store enabled rails in your own settings table. Enforce that at least one stays enabled.
2. In the checkout handler, map the buyer's chosen payment method to a `Provider` + `Method` constant.
3. If that rail is disabled in your settings, return an error before calling `Create`.
4. If the price is `0`, call `gw.CreateFree`. Otherwise call `gw.Create`.

For public-facing error responses, log the real error on the server and send `paymenterrors.PublicCheckoutMessage(err)` to the browser. It maps sentinels to short, safe messages and strips any Stripe error strings or SQL details that should not reach users.

---

## Zero-price / free checkouts {#zero-price--free}

If the order total is `0` — a 100% discount, a complimentary grant, a coupon that covers everything — do **not** call `Create`. There is no provider to talk to, no hosted page, and no webhook.

Call `gw.CreateFree(db, in)` instead. It inserts a `payments` row that is already `paid`, with `provider = "free"`, `payment_method = "free"`, and `amount = 0`. If a free row already exists for that order, it is returned as-is — the same reuse idea as `Create`, without a network call.

`in` is a `CreateFreeInput`. Required: `OrderID`. Optional: `Currency` (empty → `"USD"`) and `ProductType`.

```go
pay, err := gw.CreateFree(db, paymentProviders.CreateFreeInput{
    OrderID:     order.ID,
    Currency:    "USD",
    ProductType: ptrString("license"),
})
if err != nil {
    return err
}

// The row is already paid. Grant access in this same request.
```

Fulfillment is still your job. After `CreateFree` returns, mark the order paid and grant access immediately. `gw.SyncStatus` on a free payment is a no-op. `gw.SupportsRefund` is false — there is nothing on a provider to reverse.

---

## Batch wallet paid status

If you have an admin list page that needs to show paid/unpaid status for many wallet orders at once, there is a helper that avoids N+1 HTTP calls to the microservice:

```go
paidMap, err := gw.BatchWalletPaidStatus(ctx, orderIDs)
// paidMap["42"] == true means the microservice currently considers order 42 paid
```
