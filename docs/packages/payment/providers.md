---
title: Providers — Payment
description: Built-in rails, environment variables, adding a new provider, and the wallet admin client.
---

# Providers

Your handlers never call Stripe's or NowPayments' SDK directly. They call `gateway.Create`, `gateway.CreateFree`, `gateway.Refund`, `gateway.SyncStatus` — and the Gateway routes those calls internally. This page explains which providers ship in the box, which env vars they need, how to add a new one, and what the wallet admin client is for.

---

## Built-in rails

| Provider key | Method | What the buyer sees | Refunds? | Catalog? |
|---|---|---|---|---|
| `now_payments` | crypto | Hosted NowPayments invoice page (`InvoiceURL`) | no | no |
| `user_wallet` | crypto | Deposit address + network + asset on **your** page | no | no |
| `lemon_squeezy` | card | Hosted LS checkout (catch-all variant + `custom_price`) | yes | no |
| `stripe` | card | Hosted Checkout Session — needs a synced Stripe Product | yes | yes |
| `free` | `free` | Local paid row via `CreateFree` | no | no |

Stripe and Lemon Squeezy report "not configured" when their env vars are empty — the process still boots and the other providers work normally. NowPayments and wallet credentials **cause a fatal error on startup in production** (`APP_ENV=production`); leave them empty only in development.

---

## Environment variables {#environment-variables}

These are loaded in `payment/configs` when the package initialises.

### Wallet microservice

| Variable | Default | Notes |
|---|---|---|
| `GATEWAY_URL` | `http://localhost:8090` | Base URL of the wallet microservice |
| `GATEWAY_API_KEY` | required in production | Bearer token for `/api/*` — must be listed in `AUTHORIZED_KEYS` on the microservice |
| `GATEWAY_WEBHOOK_SECRET` | required in production | HMAC signing secret for `X-Gateway-Signature` webhook headers |

### NowPayments

| Variable | Notes |
|---|---|
| `NOWPAYMENTS_API_KEY` | Sent as `x-api-key` for invoice creation and status polling |
| `NOWPAYMENTS_EMAIL` / `NOWPAYMENTS_PASSWORD` | Used to obtain a JWT for invoice polling |
| `NOWPAYMENTS_IPN_SECRET` | HMAC secret for `x-nowpayments-sig` — must match the NowPayments dashboard exactly |
| `NOWPAYMENTS_API_BASE` | e.g. `https://api-sandbox.nowpayments.io/v1` for sandbox, live URL for production |

### Lemon Squeezy (all optional)

| Variable | Default | Notes |
|---|---|---|
| `LEMONSQUEEZY_API_KEY` | — | Bearer token |
| `LEMONSQUEEZY_STORE_ID` | — | Deliveries from other stores are ACKed and ignored |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | — | HMAC-SHA256 key for `X-Signature` — 6 to 40 characters |
| `LEMONSQUEEZY_ONETIME_VARIANT_ID` | — | Catch-all one-time variant; price is passed as `custom_price` |
| `LEMONSQUEEZY_API_BASE` | `https://api.lemonsqueezy.com` | Override in tests |
| `LEMONSQUEEZY_TEST_MODE` | `true` | Webhooks whose `test_mode` does not match are silently ACKed |

### Stripe (all optional)

| Variable | Default | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | — | `sk_test_*` in dev, `sk_live_*` in production |
| `STRIPE_PUBLISHABLE_KEY` | — | `pk_*` — frontend reference only, never used to authenticate API calls |
| `STRIPE_WEBHOOK_SECRET` | — | `whsec_*` from the Stripe dashboard for `Stripe-Signature` |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Override in tests |

Each secret must match the corresponding dashboard value:

```
GATEWAY_WEBHOOK_SECRET      ↔  wallet microservice webhook signing secret
GATEWAY_API_KEY             ↔  microservice AUTHORIZED_KEYS
NOWPAYMENTS_IPN_SECRET      ↔  NowPayments dashboard IPN secret
LEMONSQUEEZY_WEBHOOK_SECRET ↔  LS store webhook secret
STRIPE_WEBHOOK_SECRET       ↔  Stripe endpoint signing secret
```

Values containing `$` or `#` in `.env` must be single-quoted (godotenv requirement).

---

## Adding a new provider

Every rail implements `providers.Provider`. Webhook handling is a separate `webhook.Handler` registered in `webhook/manager.go`. Refunds are an **optional** extra interface — only implement it if the provider supports them.

### Step 1 — give it an identity

Add a snake_case constant in `payment/configs/constants.go`:

```go
Provider_Acme = "acme"
```

Add only the payment methods it actually supports to `SupportedMethods()`. Load credentials in `payment/configs/payment_env.go`. You choose how missing keys behave:

- **Optional** (`getEnv` / empty string, like Stripe and Lemon Squeezy) — the process always boots. `Create` returns `paymenterrors.ErrProviderNotConfigured` until the host fills the env vars. Pick this if the app should run without this rail (card-only deploys, “add this provider later”).
- **Required in production** (`requireEnv` when `APP_ENV=production`, like NowPayments and wallet) — missing keys `log.Fatalf` at startup in production, and stay optional in development. Pick this only if this host cannot ship without that rail.

Card vs crypto does not decide this. A crypto rail can be optional; a card rail can be required. Match the host’s real need.

```go
// payment/configs/payment_env.go — add fields on PaymentEnv, then load them here.

req := requireEnv
if os.Getenv("APP_ENV") != "production" {
    req = optionalEnv
}

PaymentEnvs.AcmeAPIKey = getEnv("ACME_API_KEY", "") // optional — empty is fine
// or:
PaymentEnvs.AcmeAPIKey = req("ACME_API_KEY")        // required in production
```

Never persist API keys in a settings JSON blob or expose them to the frontend.

### Step 2 — implement providers.Provider

Create `payment/providers/acme.go`:

```go
type acmeProvider struct{}

func (p *acmeProvider) Name() paymentconfigs.PaymentProvider {
    return paymentconfigs.Provider_Acme
}

func (p *acmeProvider) SupportedMethods() []paymentconfigs.PaymentMethod {
    return []paymentconfigs.PaymentMethod{paymentconfigs.Method_Card}
}

func (p *acmeProvider) Create(ctx context.Context, db *gorm.DB, in CreateInput) (*paymentmodel.Payment, error) {
    // Check credentials. Return ErrProviderNotConfigured if env vars are missing.
    // Apply the in-progress reuse rule — see stripe.go or nowpayments.go for the pattern.
    // Call the provider API. Wrap checkout failures with paymenterrors.ErrCheckoutCreate.
    // Insert the payments row using payments.id UUID as the provider order_id.
}

func (p *acmeProvider) SyncStatus(ctx context.Context, db *gorm.DB, pay *paymentmodel.Payment) (*paymentmodel.Payment, error) {
    // Poll the provider API. Update the row. Skip if pay.IsPaid() already.
}

func (p *acmeProvider) MapStatus(raw string) (markPaid bool, mapped paymentconfigs.PaymentStatus) {
    // Map provider-native strings to PaymentStatus.
    // Only return markPaid=true for known terminal success statuses.
}

func (p *acmeProvider) SyncProducts(ctx context.Context, db *gorm.DB, products []SyncProductInput) ([]SyncProductResult, error) {
    // No catalog: return one no-op result per input (empty id, nil error).
}
```

Reuse the helpers in `providers/helpers.go` — `paymentAmountMatchesOrder`, `paymentHasFunds`, `rejectDuplicateRefund`, `FindInProgressPayment`. Use `paymentconfigs.HTTPClientTimeout` for all outbound HTTP.

If the provider supports refunds, implement `Refunder` too:

```go
func (p *acmeProvider) Refund(ctx context.Context, db *gorm.DB, pay *paymentmodel.Payment, in RefundInput) (*paymentmodel.PaymentRefund, error) {
    if err := rejectDuplicateRefund(db, pay.ID); err != nil {
        return nil, err
    }
    // Call the provider API.
    // Persist the result with persistProviderRefund(...).
}
```

Once `Refund` is on the struct, `gw.SupportsRefund(Provider_Acme)` returns `true` automatically — the Gateway uses a type assertion to check.

### Step 3 — register on DefaultGateway

Add a field on `DefaultGateway`, construct it in `NewDefaultGateway()`, and add `switch` cases in `Create`, `SyncStatus`, `MapStatus`, and `providerFor` (which is used by `SyncProducts` and `Refund`).

```go
// payment/gateway.go

type DefaultGateway struct {
    // ...existing fields...
    Acme paymentProviders.Provider
}

func NewDefaultGateway() *DefaultGateway {
    return &DefaultGateway{
        // ...existing providers...
        Acme: paymentProviders.NewAcmeProvider(),
    }
}

func (g *DefaultGateway) Create(ctx context.Context, db *gorm.DB, in paymentProviders.CreateInput) (*paymentmodel.Payment, error) {
    switch in.Provider {
    // ...existing cases...
    case paymentconfigs.Provider_Acme:
        return g.Acme.Create(ctx, db, in)
    }
}

func (g *DefaultGateway) providerFor(provider paymentconfigs.PaymentProvider) (paymentProviders.Provider, error) {
    switch provider {
    // ...existing cases...
    case paymentconfigs.Provider_Acme:
        return g.Acme, nil
    }
}
```

Repeat the `Provider_Acme` case in `SyncStatus` and `MapStatus` the same way. You do not add a case to `CreateFree` — that stays on `Provider_Free` only.

### Step 4 — add webhook handling

Create `payment/webhook/acme.go` — same folder as `stripe.go`, `lemonsqueezy.go`, `nowpayments.go`, and `wallet.go`. Package name is `paymentWebhook`. Implement `webhook.Handler` there with a `ProcessWebhook` method. Verify the HMAC signature **before** reading any status fields.

```go
// payment/webhook/acme.go
package paymentWebhook

type AcmeWebhook struct{}

func (AcmeWebhook) ProcessWebhook(ctx context.Context, in Input) (*Event, error) {
    secret := paymentconfigs.PaymentEnvs.AcmeWebhookSecret
    if secret == "" {
        return nil, ErrNotConfigured
    }
    if err := verifyAcmeSignature(secret, in.Headers, in.Body); err != nil {
        return nil, ErrUnauthorized
    }

    // Parse in.Body only after the signature matches.
    paymentID := /* payments.id UUID from the payload */
    rawStatus := /* provider-native status string */

    markPaid, mapped, err := in.Gateway.MapStatus(paymentconfigs.Provider_Acme, rawStatus)
    if err != nil {
        return nil, err
    }
    return &Event{
        Provider:      paymentconfigs.Provider_Acme,
        PaymentID:     paymentID,
        MarkPaid:      markPaid,
        PaymentStatus: mapped,
    }, nil
}
```

Then register it in `handlerFor` inside `payment/webhook/manager.go`. Do not add a new file for this — that switch is how `Process` picks the handler.

```go
// payment/webhook/manager.go
func handlerFor(provider paymentconfigs.PaymentProvider) (Handler, error) {
    switch provider {
    // ...existing cases...
    case paymentconfigs.Provider_Acme:
        return AcmeWebhook{}, nil
    default:
        return nil, fmt.Errorf("%w: %q", ErrUnsupported, provider)
    }
}
```

The host still writes the HTTP route and the apply logic — the package only handles verification and normalization. The route looks like the ones on [Webhooks](./webhooks#writing-the-handler), with `Provider_Acme` passed to `Process`.

### Step 5 — tell the host about it

The package does not store which providers are enabled at checkout. Your settings table and checkout UI need to learn the new snake_case key. Make sure at least one rail stays enabled.

---

## Wallet admin client

`payment/admin.NewWalletAdmin()` is a separate HTTP client for the wallet microservice's admin API. It is not a substitute for `Gateway` — you use `gw.Create` to open checkouts, and `WalletAdmin` to manage the microservice itself.

| Method | What it does |
|---|---|
| `RecheckPayment` | Triggers a manual on-chain status recheck |
| `ExtendExpiration` | Extends the deposit window for a payment |
| `CancelPayment` | Cancels an in-progress wallet order |
| `SweepPayment` / `GetSweepStatus` | Initiates or checks a treasury sweep |
| `Health` | Health check + settings snapshot. Uses a 3-second timeout so a down microservice does not block admin page loads. |
| `UpdateSettings` | Runtime settings: webhook URL, sweep configuration, polling intervals. Secrets are masked in the response. |
| `Restart` | Restarts the microservice's background jobs |

The treasury address lives on the microservice environment, not in this package. Set `webhook_url` via `UpdateSettings` or wallet will never POST to your webhook route — see [Webhooks](./webhooks#wallet).
