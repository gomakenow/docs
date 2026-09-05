---
title: Providers — Mailing
description: Which mail provider is active, environment variables, and adding a new provider.
---

# Providers

The mailing package does not call Mailtrap or Mailgun directly from your application code. It goes through a `providers.Gateway` interface. The engine picks the active provider once at startup and all jobs are sent through it. This page explains how that selection works, which environment variables each provider needs, and how to wire in a new provider.

---

## Which provider is active

The engine reads the environment at startup to decide which provider to use:

1. If `MAIL_PROVIDER` is explicitly set to `mailgun` or `mailtrap`, that one is used.
2. Otherwise, if `APP_ENV=production`, Mailgun is used.
3. Otherwise, Mailtrap is used.

Mailtrap is the safe default for development — it captures every outgoing email in a sandbox inbox so nothing is ever sent to a real address. Switch to Mailgun (or another provider) when you are ready to send for real.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `MAIL_PROVIDER` | Explicit provider override: `mailgun` or `mailtrap`. Leave blank to use the automatic rule above. |
| `MAIL_FROM_ADDRESS` | Default From address for all emails. Can be overridden per-message with `Message.From`. |
| `MAIL_FROM_NAME` | Display name that appears alongside the From address. |
| `MAILGUN_DOMAIN` | Your Mailgun sending domain, e.g. `mg.example.com`. |
| `MAILGUN_PRIVATE_KEY` | Mailgun API key. |
| `MAILGUN_API_BASE` | Mailgun API base URL. Default: `https://api.eu.mailgun.net/v3`. |
| `MAILTRAP_API_TOKEN` | Mailtrap API token. |
| `MAILTRAP_INBOX_ID` | Mailtrap sandbox inbox ID. |
| `MAILTRAP_API_BASE` | Mailtrap API base URL. Default: `https://sandbox.api.mailtrap.io`. |
| `EMAIL_SEND_DELAY_MS` | Pause between sends in one worker cycle (default: `250`ms). Prevents flooding the provider during a large batch. |

If a job has a `From` address set — via `Message.From` or `BatchInput.From` — that overrides `MAIL_FROM_ADDRESS` for that email only.

---

## Adding a new provider

Each provider implements one interface: `providers.Provider`. Adding a new vendor means implementing that interface, registering the struct in `providers.NewGateway`, and adding a selection case in `DefaultGateway.active()`. The worker calls `Gateway.Send` and never needs to change.

### Step 1 — implement `providers.Provider`

Create a new file in `backend/mailing/providers/`, e.g. `sparkpost.go`. Define a struct that holds whatever credentials the provider needs, then implement two methods: `Name()` which returns the provider's identifier string, and `Send()` which makes the actual API call.

```go
// backend/mailing/providers/sparkpost.go

type SparkPostProvider struct {
    apiKey string
}

func (p *SparkPostProvider) Name() string {
    return "sparkpost"
}

func (p *SparkPostProvider) Send(ctx context.Context, msg providers.Delivery) (string, error) {
    // msg carries everything needed to send: To, From, FromName, Subject, HTML.
    messageID, err := callSparkPostAPI(ctx, p.apiKey, msg)
    if err != nil {
        if isTemporaryError(err) {
            // Retryable: network hiccup, rate limit, provider timeout.
            // The worker will retry this job up to 3 times total.
            return "", providers.Retryable(err)
        }
        // Permanent: bad address, invalid credentials, provider rejected the message.
        // The worker will not retry.
        return "", providers.Permanent(err)
    }
    return messageID, nil
}
```

Always wrap errors with `providers.Retryable(err)` or `providers.Permanent(err)`. The worker calls `providers.IsRetryable(err)` to decide whether to retry a failed job — an unwrapped error is not treated as retryable.

### Step 2 — add env vars in `mailing/configs`

Add a `SparkPostConfig` struct and load it from environment variables, the same way `MailgunConfig` and `MailtrapConfig` do in that package.

### Step 3 — register it in `providers.NewGateway`

`NewGateway` builds the list of all known providers. Add yours:

```go
func NewGateway() *DefaultGateway {
    return &DefaultGateway{
        providers: []Provider{
            newMailgun(),
            newMailtrap(),
            newSparkPost(), // add here
        },
    }
}
```

### Step 4 — select it in `DefaultGateway.active()`

This is where `MAIL_PROVIDER=sparkpost` gets routed to your struct. Add a case:

```go
case "sparkpost":
    return p, nil
```

That is all. The worker still calls `Gateway.Send` — nothing else changes.
