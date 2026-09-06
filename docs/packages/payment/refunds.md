---
title: Refunds — Payment
description: payment_refunds vs payments.status, gateway.Refund, duplicate guard, inbound dashboard refunds.
---

# Refunds

Collection and refunds are stored in two separate tables, and that is intentional. A `payments` row can stay `paid` while a `payment_refunds` row is `pending`. This way a refund that is currently in flight does not make the original charge look like it never succeeded — which matters if you are showing payment status anywhere in your UI.

This page is about issuing refunds. Opening a checkout is [Creating payments](./create). Inbound refund notifications from the provider arrive as webhooks and are covered in [Webhooks](./webhooks) under `event.IsRefund()`.

---

## What the package checks before calling the provider

Before making any API call, `gateway.Refund` looks at `payment_refunds` for this `payment_id`. If a refund is already in flight or completed, it stops:

| State of existing refund rows | What happens |
|---|---|
| No rows, or only `failed` rows | Proceeds — calls the provider |
| A `pending` row exists | Returns `paymenterrors.ErrRefundInProgress` |
| A `succeeded` row exists | Returns `paymenterrors.ErrAlreadyRefunded` |

This prevents an admin from double-clicking a Refund button and accidentally sending two separate refund requests to Stripe.

::: warning The package does not check `payments.status`
If you call `Refund` on a payment that is still `pending` or has `expired`, the package will still try. The provider may reject it — that is their call. **Your code** is responsible for checking that the payment is actually `paid` before offering a refund option to anyone.
:::

---

## Checking whether the provider supports refunds

Not every provider can issue refunds. Before you build a refund button in the admin, check:

```go
if !gw.SupportsRefund(paymentconfigs.PaymentProvider(pay.Provider)) {
    // Show a different admin action — e.g. "Handle manually via treasury"
    return paymenterrors.ErrRefundNotSupported
}
```

What is supported today:

| Provider | Refunds? |
|---|---|
| Stripe | Yes |
| Lemon Squeezy | Yes |
| NowPayments | No |
| Wallet | No |
| Free | No |

For crypto providers, the typical approach is a manual treasury transfer. Show a different admin action for those rather than a Refund button.

---

## Issuing a refund

After you have checked eligibility and confirmed the provider supports refunds, call `gateway.Refund`:

```go
refund, err := gw.Refund(ctx, db, pay, paymentProviders.RefundInput{
    Amount: nil,                      // nil = full amount; pass a *float64 for a partial refund
    Reason: "requested_by_customer",
})
```

`RefundInput` fields:

- **`Amount`** — `nil` refunds the full payment amount. To do a partial refund, pass a pointer to the dollar amount. The package converts to cents for providers that require it.
- **`Reason`** — stored on the local row and forwarded to the provider where the API supports it.
- **`IdempotencyKey`** — Stripe only. If you leave it empty, the package uses `"refund-{payment_id}"` automatically. You only need to set this if you want a different key.

What comes back:

- `refund` — the newly created or updated `payment_refunds` row.
- `err` — non-nil means something went wrong. `ErrRefundFailed` means the provider or the HTTP call reported a failure.

Stripe often returns `pending` and settles the refund later via a `refund.updated` webhook. Lemon Squeezy reports `succeeded` immediately on the API response.

A `failed` refund row does **not** block you from calling `Refund` again later. Only `pending` and `succeeded` rows block.

---

## Refund statuses

The `status` column in `payment_refunds`:

| Status | What it means |
|---|---|
| `pending` | The provider accepted the refund but has not returned funds to the buyer yet. Normal for Stripe. |
| `succeeded` | Terminal success. The refund is done. Webhooks cannot regress this back to `pending`. |
| `failed` | The provider rejected it or the HTTP call failed. May become `succeeded` on a later attempt. |

---

## Inbound refunds from the provider dashboard

A refund can start in two places:

| Started from | What happens |
|---|---|
| **Your admin / your API** | You call `gw.Refund`. The package talks to Stripe or Lemon Squeezy and writes a local `payment_refunds` row. Later webhooks only update that row as it settles. |
| **The provider dashboard** | Someone clicks Refund in Stripe or Lemon Squeezy. Your code never called `Refund`. The first you hear is a webhook. |

::: info “Inbound” means it did not start in your app
This section is the second row: a refund that began in the provider’s dashboard (or their API), not your admin panel.
:::

The webhook looks the same either way — `event.IsRefund()` is true. Always write it with `paymentmodel.UpsertRefund`. That inserts a row if the refund was inbound, or updates the row if you already called `gw.Refund`.

::: warning Do not call `gateway.Refund` from a webhook
`Refund` would try to refund the provider again, or hit the duplicate guard. Webhooks only record what already happened. Use `UpsertRefund`.
:::

Run your access clawback when `RefundStatus` is `pending` or `succeeded`. Do not wait for a "settled" event if the provider already accepted the refund.

---

## Looking up refunds

```go
// All refunds for a specific payment (most common)
refunds, err := paymentmodel.ListRefundsByPaymentID(db, paymentID)

// All refunds across all payments on an order
refunds, err = paymentmodel.ListRefundsByOrderID(db, orderID)

// Just the latest succeeded or pending refund
latest, err := paymentmodel.LatestSucceededRefund(db, paymentID)
latest, err  = paymentmodel.LatestPendingRefund(db, paymentID)

// By provider refund id (useful in webhooks)
refund, err := paymentmodel.GetRefundByProviderRefundID(db, provider, providerRefundID)
```

When you load a payment with `paymentmodel.GetPaymentByID`, the newest refund row is automatically attached as `pay.LatestRefund`. Useful for admin screens that need to show both collection status and refund status together.

The `order_id` column on every `payment_refunds` row is copied from the payment at write time. You can query refunds by order id without a join.

---

## Marking a refund succeeded without the provider

If the provider API call failed but the dashboard later confirms the refund completed, you can update the local row directly:

```go
refund, err := paymentmodel.MarkRefundSucceeded(db, existingRefundRow)
```

This only updates your database. It does not make any API call. Still run your access clawback if you have not already.

---

## After a refund — what your code needs to do

The package never revokes licenses, sends a "your refund is done" email, or removes access. After `gateway.Refund` returns, or after applying a refund webhook, your service needs to:

1. **Revoke access immediately.** Do not wait for `succeeded` if the provider already accepted `pending`. Most providers settle quickly, but you should treat the access as revoked as soon as the refund is accepted.
2. **Make clawback safe to run twice.** If `Refund` returns `ErrRefundInProgress` or `ErrAlreadyRefunded` on a retry, that does not mean you should skip the revoke — it may mean the first attempt partly succeeded and died before clawback ran.
3. **Never revoke access on a failed refund.** `ErrRefundFailed` means nothing happened on the provider's side. Do not remove access until a refund actually succeeds.
