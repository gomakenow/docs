---
title: Webhooks — Payment
description: Verify provider deliveries, normalize them into Event, then apply in the host.
---

# Webhooks

After [Creating payments](./create), the buyer finishes on the provider's hosted page or sends crypto to the deposit address. When that happens, the provider sends a POST request to a URL you registered. This page is about what to do with that request.

The work is split on purpose. The package handles the hard part — verifying the HMAC signature so you know the delivery is genuine, parsing the provider-specific payload, and handing you a single normalized `Event` struct regardless of which provider sent it. Your code handles the business part — loading the relevant rows, granting access, and returning `200` so the provider stops retrying.

---

## Writing the handler

Every provider needs a public POST endpoint. The path can be hard to guess, but **obscurity is not authentication** — the signature is. A guessable URL without a valid signature still gets rejected by the package.

The most important thing: **read the raw body before doing anything else**. Signature checks run against the exact bytes that arrived. If you parse the JSON first and then try to re-encode it, the bytes will differ slightly and the check will fail.

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
        Gateway: h.gw, // nil falls back to NewDefaultGateway()
    })
    if err != nil {
        // Return an error status so you notice misconfiguration.
        // See the error table below for how to map errors to status codes.
        http.Error(w, "webhook rejected", http.StatusForbidden)
        return
    }

    // Apply the event — see "Applying events" below.
    w.WriteHeader(http.StatusOK)
}
```

Pass the provider as the first argument. Each provider has its own route — the provider constant tells `Process` which signature algorithm to use. Passing an unknown key returns `webhook.ErrUnsupported`.

Map errors to HTTP status codes like this:

| Error | HTTP status to return |
|---|---|
| `webhook.ErrUnauthorized` | `403` — bad or missing signature |
| `webhook.ErrBadRequest` | `400` — malformed JSON or missing required fields |
| `webhook.ErrNotConfigured` | `500` — the webhook secret env var is empty |
| `webhook.ErrUnsupported` | `400` — unknown provider key |

Return `4xx` or `5xx` when verification fails so you notice misconfiguration early. For authentic payloads that you decide to no-op — an event type you do not handle, a test-mode mismatch, a delivery you already processed — return `200`. Providers retry on non-`2xx`, so a handler that always returns `500` from a buggy fulfillment path will get hammered.

---

## Reading the Event

`Process` gives back an `*Event`. Most of its fields will be empty — only the ones relevant to this particular delivery are set. Here are the ones you will check in every handler:

**`event.PaymentID`** — the `payments.id` UUID you received when you called `Create`. Use this to load the payment row from your database.

**`event.MarkPaid`** — `true` when the provider reported a known terminal-success status. This is the signal to fulfill the order. It is `false` for partial payments, confirmations, expiries, and anything that is not an unambiguous success.

**`event.PaymentStatus`** — carries non-success status updates: `expired`, `failed`, `partially_paid`, and so on. If this is empty, do not change the payment's collection status from this delivery.

**`event.IsRefund()`** — returns `true` when `RefundStatus` is set. When that is the case, this delivery is about a refund, not a collection update. Update `payment_refunds` and run your access clawback. Do **not** write `payments.status = "refunded"` — collection and refunds are tracked separately so a refund in flight does not make the charge look like it never succeeded.

Some deliveries are authentic but should be no-ops: a Lemon Squeezy `test_mode` mismatch, a Stripe session that the package did not create (no `metadata.payment_id`), or a wallet event type you do not handle. Those return a no-op event — always respond `200` to these so the provider does not keep retrying.

The full `Event` struct:

```go
type Event struct {
    Provider          PaymentProvider
    PaymentID         uuid.UUID   // payments.id — match this to your database
    ProviderPaymentID string      // provider's own reference id
    MarkPaid          bool
    PaymentStatus     PaymentStatus
    PaidValue         *float64
    PaidAt            *time.Time
    OnChainBalance    *float64
    MarkSwept         bool        // wallet: funds moved to treasury
    SweptAt           *time.Time
    SweptBy           string

    // These are set only when IsRefund() returns true
    RefundStatus        RefundStatus
    ProviderRefundID    string
    RefundAmount        *float64
    RefundCurrency      string
    RefundFailureReason string
}
```

---

## Applying the event

A safe apply function in your handler follows this sequence:

1. **Check `event.IsRefund()` first.** If true, upsert the refund row with `paymentmodel.UpsertRefund` and run your access clawback if the status is `pending` or `succeeded`. Return `200`.
2. **Load the payment.** `paymentmodel.GetPaymentByID(db, event.PaymentID)`. If the row does not exist, log it and return `200` — a redelivery cannot create a payment row, and panicking here would just cause more retries.
3. **Apply `MarkPaid`.** If `event.MarkPaid` is true and the payment is not already paid, call `pay.MarkPaid(db, paidValue, paidAt)` inside a transaction alongside your order fulfillment (grant the license, mark the order as paid, send the receipt email queue call).
4. **Apply `PaymentStatus`.** If `event.PaymentStatus` is set and `MarkPaid` was not, update the status — `expired`, `failed`, `partially_paid`, etc.
5. **Apply `MarkSwept`** if set (wallet provider only). Persist the sweep columns on the payment row.
6. **Guard against double-fulfillment.** Check that the order is not already fulfilled before granting access or sending purchase emails. The provider will retry; your fulfillment must be safe to attempt twice.

The package will process the same raw body correctly twice. Idempotency in your apply code is your responsibility.

---

## Signature format per provider

You still register the URL in each dashboard. The secret must match the env var.

### Stripe

| Item | Detail |
|---|---|
| Header | `Stripe-Signature: t=<unix>,v1=<hex>` |
| Secret | `STRIPE_WEBHOOK_SECRET` — the `whsec_…` value from the Stripe dashboard |
| Algorithm | HMAC-SHA256 over `{timestamp}.{raw body}`. Skew tolerance is 5 minutes. |

Collection events the package handles: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Sessions without `metadata.payment_id` are ignored — the package always sets that metadata in `Create`.

Refund events: `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`. Matched by `metadata.payment_id` or `payments.provider_payment_id`.

### Lemon Squeezy

| Item | Detail |
|---|---|
| Header | `X-Signature: <hex>` |
| Secret | `LEMONSQUEEZY_WEBHOOK_SECRET` — 6 to 40 characters |
| Algorithm | HMAC-SHA256 over the raw body |

Subscribe broadly in **LS → Settings → Webhooks** — the package filters internally. Deliveries whose `test_mode` field does not match `LEMONSQUEEZY_TEST_MODE` (default `true`) are ACKed and silently ignored.

`Process` handles one-time payment events (`order_created`, `order_refunded`). If you sell subscriptions, call `ParseLemonSqueezyWebhook` and branch on `IsSubscriptionEvent()` — that branching logic is yours, not the package's.

### NowPayments

| Item | Detail |
|---|---|
| URL | Whatever you passed as `CreateInput.NotificationURL` when creating the payment |
| Header | `x-nowpayments-sig` |
| Secret | `NOWPAYMENTS_IPN_SECRET` — must match the NP dashboard exactly |
| Algorithm | HMAC-SHA512 over canonical sorted JSON |

### Wallet

| Item | Detail |
|---|---|
| Header | `X-Gateway-Signature: sha256=<hex>` |
| Secret | `GATEWAY_WEBHOOK_SECRET` |
| Algorithm | HMAC-SHA256 over the raw body |
| Events | `order.partially_paid`, `order.paid`, `order.expired`, `order.swept` |

The webhook URL for the wallet must be set on the **microservice** via `payment/admin.WalletAdmin.UpdateSettings`. Just having the Go route is not enough — if the microservice has no `webhook_url` configured, it never POSTs anything.

---

## What to do when a webhook never arrives

If the buyer paid but your route was down or the delivery was lost:

- Stripe, Lemon Squeezy, and NowPayments retry automatically on non-`2xx` responses.
- You can also load the payment row and call `gw.SyncStatus(ctx, db, pay)`. It polls the provider and updates the row.

Do not infer payment success from the success-page URL query string. The success URL is a UX redirect after checkout. It is not proof of payment.
