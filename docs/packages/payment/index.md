---
title: Payment
description: Provider gateway for checkout, webhooks, refunds, and catalog sync. You own orders and fulfillment.
---

# Payment

<Badge type="tip" text="Requires migration" />

The `payment` package (`backend/payment/`) is how your app talks to card and crypto payment providers — Stripe, Lemon Squeezy, NowPayments, and an on-chain wallet — without importing any of their SDKs from your handlers.

You still write the order, the HTTP route, and what happens when money arrives. The package owns the provider API calls, the `payments` row in your database, signature verification on webhooks, and status mapping.

The reason for this separation matters. If you called Stripe directly from a handler and the request timed out, you would have no idea whether Stripe created the checkout session on their side or not. After `gateway.Create` returns, the attempt is committed as a row in your database. If the browser closes, a later webhook or a `SyncStatus` poll still finds it and can act on it.

```
Your app
  main.go:  gw := payment.NewDefaultGateway()   ← build once, inject everywhere

  handler:  gw.Create(...)                       ← routes to Stripe / LS / NP / wallet
            redirect buyer to pay.InvoiceURL     (or show a wallet deposit address)

Provider — minutes or hours later:
  POSTs webhook to YOUR route
  paymentWebhook.Process(...)                    ← verifies the HMAC signature
  your handler applies the event                 ← fulfill / refund / ignore
```

The object you hold is a **`payment.Gateway`**. It is an interface — one set of methods (`Create`, `CreateFree`, `SyncStatus`, `Refund`, …) that work identically regardless of the provider. You call `payment.NewDefaultGateway()` once at startup (Step 3 below). That gives you a `*DefaultGateway` — the built-in implementation — with every shipped provider already wired. Pass it into handlers. In tests, swap it with a fake that implements the same interface so nothing ever hits a live provider.

::: info What payment does not do
The package does not create orders, pick which providers are enabled at checkout, grant licenses, send purchase emails, or register HTTP routes. It also does not decide who may refund — eligibility (paid-only, product rules, admin-only UI) is your code. You write all of that.
:::

You can wire the whole thing in **five steps**: publish the migration, set credentials, build the Gateway, call `Create`, and register a webhook route.

---

## Step 1 — Publish and run the migration

The package ships its own SQL files. Publish them into your app's migrations folder and apply:

```sh
make -C backend/payment migrate-publish
make migrate-up
```

This creates three tables:

| Table | What it stores |
|---|---|
| `payments` | One row per payment attempt. Holds the invoice URL, deposit address, provider ids, and collection status. |
| `payment_refunds` | One row per refund attempt. Kept separate from `payments` intentionally — a refund in flight should not make the original charge look like it never succeeded. |
| `gateway_products` | Maps your catalog product id to a provider-side catalog object. Used by catalog-backed providers (Stripe today). Empty until synced; other providers never touch it. |

The published SQL adds foreign keys on `payments.order_id → orders(id)`, `payment_refunds.payment_id → payments(id)`, and `gateway_products.product_id → products(id)`. These assume **bigint** primary keys on your `orders` and `products` tables. Those tables must exist before you run `migrate-up`. If your ids are UUIDs, edit the published files before applying — see [Migrations](/guide/migrations).

You do not need to understand every column right now. The full schema is on the [Reference](./reference#tables) page.

---

## Step 2 — Set environment variables

Credentials are loaded from `payment/configs` when the package initialises.

Card providers — Stripe and Lemon Squeezy — are **optional**. If their env vars are empty, the process still starts normally. Calling `Create` with a missing provider just returns `paymenterrors.ErrProviderNotConfigured` instead of crashing. This means you can start with one provider and add the rest later.

Crypto providers — NowPayments and the wallet microservice — are **required in production** (`APP_ENV=production`). Missing vars will fatal the process at startup.

```sh
# Stripe (card — all optional)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_test_...    # frontend reference only; never used to authenticate API calls

# Lemon Squeezy (card — all optional)
LEMONSQUEEZY_API_KEY=...
LEMONSQUEEZY_STORE_ID=...
LEMONSQUEEZY_WEBHOOK_SECRET=...       # 6–40 chars; must match the LS dashboard
LEMONSQUEEZY_ONETIME_VARIANT_ID=...  # catch-all variant; price is sent as custom_price

# NowPayments (crypto — required in production)
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_EMAIL=...
NOWPAYMENTS_PASSWORD=...
NOWPAYMENTS_IPN_SECRET=...            # must match the NowPayments dashboard IPN secret
NOWPAYMENTS_API_BASE=https://api-sandbox.nowpayments.io/v1

# Wallet microservice (crypto — required in production)
GATEWAY_URL=http://localhost:8090
GATEWAY_API_KEY=...                   # must be listed in the microservice AUTHORIZED_KEYS
GATEWAY_WEBHOOK_SECRET=...            # HMAC key for X-Gateway-Signature
```

Values containing `$` or `#` must be single-quoted in `.env`. The complete list, with defaults and alignment notes, is on the [Providers](./providers#environment-variables) page.

---

## Step 3 — Build the Gateway and inject it

Call `payment.NewDefaultGateway()` once in `main.go`. It constructs a `*DefaultGateway` with all four built-in providers wired. Pass it into every handler or service that needs to create a payment, issue a refund, or process a webhook.

```go
// main.go
gw := payment.NewDefaultGateway()

checkoutHandler := NewCheckoutHandler(db, gw)
webhookHandler  := NewWebhookHandler(db, gw)
```

Your handlers should accept the `payment.Gateway` **interface**, not the concrete `*DefaultGateway`. That way tests can inject a fake without touching production code. Never import a file from `payment/providers/` directly in a handler — always go through the Gateway you injected.

---

## Step 4 — Create a payment

To open a checkout, call `gw.Create(ctx, db, in)`. The Gateway calls the provider, inserts a `payments` row, and returns. The buyer has not paid yet — they still need to complete the hosted checkout page or send crypto to the deposit address.

`in` is a `paymentProviders.CreateInput`. It is not your GORM `Order` model — you copy the few fields the package needs. The minimum required fields are the order id, user id, price, product id, product name, method, and provider. Every field is documented on the [Creating payments](./create) page.

```go
pay, err := gw.Create(ctx, db, paymentProviders.CreateInput{
    Order: &paymentmodel.OrderInput{
        ID:     order.ID,    // your orders.id
        UserID: order.UserID,
        Price:  order.Price,
    },
    SubOrder: &paymentmodel.SubOrderInput{
        ProductID: product.ID,
        Name:      product.Name,
    },
    Method:     paymentconfigs.Method_Card,
    Provider:   paymentconfigs.Provider_Stripe,
    Currency:   "USD",
    SuccessURL: "https://example.com/pay/success?payment_id={payment_id}",
    BuyerEmail: user.Email,
})
if err != nil {
    // Log the real error on the server.
    // PublicCheckoutMessage strips provider internals before sending to the browser.
    http.Error(w, paymenterrors.PublicCheckoutMessage(err), http.StatusBadRequest)
    return
}

// Redirect the buyer to the hosted checkout page.
// They'll complete their card details there. You get a webhook when they pay.
http.Redirect(w, r, *pay.InvoiceURL, http.StatusFound)
```

Notice `{payment_id}` in `SuccessURL` — the package replaces it with the new `payments.id` UUID before the row is inserted. That UUID, `pay.ID`, is also what the provider stores as `order_id` on their side. When a webhook arrives later, it comes back referencing that UUID — not your `orders.id`.

For wallet checkouts there is no hosted page to redirect to. Instead you show `pay.WalletAddress`, `pay.Network`, and `pay.Asset` to the buyer on your own page and wait for a webhook.

To use a different rail, just swap `Method` and `Provider`. The rest of the code is identical.

If the order total is `0` — a 100% coupon, a complimentary grant — do **not** call `Create`. There is no provider to talk to. Call `gw.CreateFree` instead; it writes a paid `payments` row locally. Full details are on [Creating payments](./create#zero-price--free).

---

## Step 5 — Register a webhook route

After the buyer pays, the provider POSTs to a URL you registered in their dashboard. You write the HTTP route. The package verifies the signature and hands you a normalized `Event`. You apply it.

One important detail: **read the raw body before any JSON parsing**. HMAC signature checks run against the exact bytes that arrived. Decoding and re-encoding first breaks the check.

```go
func (h *WebhookHandler) HandleStripe(w http.ResponseWriter, r *http.Request) {
    rawBody, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    event, err := paymentWebhook.Process(r.Context(), paymentconfigs.Provider_Stripe, paymentWebhook.Input{
        Headers: r.Header,
        Body:    rawBody,
        Gateway: h.gw,
    })
    if err != nil {
        // Bad or missing signature, malformed body, or missing env var.
        // Return 4xx/5xx so you notice misconfiguration.
        http.Error(w, "webhook rejected", http.StatusForbidden)
        return
    }

    if event.IsRefund() {
        // A refund update arrived — update payment_refunds and run your clawback.
        // Do NOT set payments.status = "refunded".
        w.WriteHeader(http.StatusOK)
        return
    }

    if event.MarkPaid {
        // Load the payment by event.PaymentID, then fulfill the order.
        // Guard against running fulfillment twice — providers will retry on non-2xx.
    }

    w.WriteHeader(http.StatusOK)
}
```

Register this URL in the provider's dashboard. Make sure the webhook secret env var matches what you set there. Every provider has a different signature format — details are on the [Webhooks](./webhooks) page.

---

## What happens after a payment is created

1. The `payments` row sits at `status = pending`. The buyer is on the hosted checkout page (or has a deposit address).
2. The provider POSTs your webhook. `Process` verifies the signature and returns an `Event` with `MarkPaid`, `PaymentStatus`, or refund fields set.
3. Your handler marks the payment paid, fulfills the order once, or updates the refund row.
4. If the webhook is lost — provider was down, your server was restarting — call `gw.SyncStatus(ctx, db, pay)` from an admin "Refresh" button or a background job. It polls the provider and updates the row. Rows that are already `paid` are left alone.

A free checkout skips this loop. `CreateFree` returns a row that is already `paid`. You fulfill in the same request — there is no webhook.

---

## What's next

| Page | What you'll find |
|---|---|
| [Creating payments](./create) | Every `CreateInput` field, reuse rules, `CreateFree`, `SyncStatus`, collection statuses |
| [Catalog sync](./catalog) | `gateway_products`, `SyncProducts`, lazy sync during `Create`, idempotency prefixes |
| [Webhooks](./webhooks) | `Process`, `Event` fields, per-provider signatures, how to apply without double-fulfilling |
| [Refunds](./refunds) | How the two tables work, `gateway.Refund`, duplicate guard, inbound dashboard refunds |
| [Providers](./providers) | Built-in rails, env vars, adding a new provider, wallet admin client |
| [Reference](./reference) | Gateway signatures, sentinel errors, table schemas |
| [Testing](./testing) | `paytest.OpenTestDB`, `SeedTestOrder`, mocking providers |
