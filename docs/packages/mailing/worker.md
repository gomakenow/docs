---
title: Worker — Mailing
description: How the background worker claims and sends jobs, BeforeSend, Logger, and retries.
---

# Worker

The worker is the background goroutine that picks up jobs from `mailing_jobs` and calls the mail provider. You start it with `mailer.Start()` in [Getting started](./#step-3--build-the-engine-and-start-the-worker). This page explains what it does on each wake, how you can inspect or cancel a send before it goes out, how to keep a permanent log of sent mail, and how retries work. Provider selection and adding a new provider are on the [Providers](./providers) page.

---

## What the worker does on each wake

When the worker wakes up (either because `Queue` signalled it, or on its 5-second background poll), it runs through these steps:

1. Opens a database connection using `Config.OpenDB`.
2. Recovers any jobs that are stuck in `processing` from a previous worker that died mid-send. A job is considered stale if it has been `processing` for more than 5 minutes without the provider being contacted, or more than 1 hour once the provider call has started.
3. Queries for up to 10 jobs where `status = queued` and `available_at <= now`, ordered by **priority ascending** then `created_at`. Lower priority number = claimed first. Transactional emails (priority `0`) are always ahead of bulk newsletter jobs (priority `100`).
4. For each claimed job:
   - Marks it `processing`.
   - Runs `BeforeSend` if you configured one.
   - Calls `Gateway.Send` (your active Mailtrap or Mailgun driver).
   - Calls `Logger` if you configured one.
   - On success: marks any tracking row as sent, deletes the job row, updates batch counters.
   - On failure: either re-queues with a delay (retryable) or marks `failed` (not retryable).
5. Pauses for `EMAIL_SEND_DELAY_MS` (default 250ms) between jobs so you do not burst the provider rate limit.
6. If any jobs were processed, loops immediately. If the queue was empty, waits for the next signal or the 5-second poll.

You do not write this loop. You only call `Start()` once.

---

## BeforeSend — check conditions just before sending {#beforesend}

`Config.BeforeSend` is an optional function that runs after a job is claimed but **before** the provider is called. It receives the job as it was queued — already committed to the database — so you can make a database query to check whether conditions have changed since queue time.

```go
mailer := mailing.New(mailing.Config{
    OpenDB: db.GetConnection,
    BeforeSend: func(db *gorm.DB, job *mailing.Job) error {
        // job.EmailType is the Type string you set when calling Queue.
        // job.Recipient is the email address.

        // Example: do not send digest emails to people who unsubscribed
        // after the batch was queued.
        if job.EmailType == "digest" {
            unsubscribed, err := subscriptions.IsUnsubscribed(db, job.Recipient)
            if err != nil {
                return err // treated as a retryable failure
            }
            if unsubscribed {
                return mailing.ErrRejected // skip permanently, no retry
            }
        }
        return nil
    },
})
```

What each return value does:

- **`nil`** — everything is fine, send proceeds.
- **`mailing.ErrRejected`** — the email is permanently skipped. The provider is never called. The job is marked as a non-retryable failure and will not be retried. Use this when the email should never be sent (the user unsubscribed, the account was deleted, etc.).
- **Any other error** — treated as a transient failure. The job is re-queued with a ~1 minute delay and retried up to 3 attempts total.

`ErrRejected` is the only tool the package gives you for cancelling a queued email. There is no "delete job" API — if you need to cancel a job for another reason, return `ErrRejected` from `BeforeSend`.

---

## Logger — keeping a permanent record of sent mail {#logger}

Successful `mailing_jobs` rows are deleted when the send succeeds. If your app needs a permanent audit log of every email attempt (for support, compliance, or debugging), implement `mailing.Logger`.

`Config.Logger` is an optional interface:

```go
type Logger interface {
    LogAttempt(attempt mailing.Attempt) error
}
```

`LogAttempt` is called after **every** provider attempt — success or failure. The `Attempt` struct contains:

```go
type Attempt struct {
    Type              string  // the job.EmailType
    SourceID          string
    Recipient         string  // email address
    From              string
    Subject           string
    HTML              string  // full body at send time
    Provider          string  // "mailgun" or "mailtrap"
    ProviderMessageID string  // provider's ID, empty on failure
    UserID            *int64
    SubscriptionID    *int64
    JobID             string
    Err               error   // nil on success, non-nil on failure
}
```

Implement this on a struct that holds a `*gorm.DB` and writes to your own `sent_emails` table (or wherever you want the log).

First, define a struct that holds the database connection your logger needs:

```go
type sentMailLogger struct {
    db *gorm.DB
}
```

Then give that struct a `LogAttempt` method. This is how Go interfaces work — by defining this method on your struct, it automatically satisfies `mailing.Logger` and can be passed as one:

```go
func (l *sentMailLogger) LogAttempt(a mailing.Attempt) error {
    return l.db.Create(&SentEmail{
        EmailType: a.Type,
        Recipient: a.Recipient,
        Subject:   a.Subject,
        Success:   a.Err == nil,
        SentAt:    time.Now(),
    }).Error
}
```

Then wire it into the engine at startup:

```go
mailer := mailing.New(mailing.Config{
    OpenDB: db.GetConnection,
    Logger: &sentMailLogger{db: db},
})
```

Errors returned from `LogAttempt` are ignored by the worker. The send is already done at that point; a logging failure does not cause a retry.

---

## How retries work

Every `mailing_jobs` row has an `attempts` counter and a `retryable` flag. The worker increments `attempts` each time it tries to send. Once `attempts` reaches 3, the job is left as `failed` and the worker stops touching it. What happens between attempts depends on where the failure occurred.

**If the failure happens before the provider is even called** — for example `BeforeSend` returned a non-`ErrRejected` error — the job is put back to `status = queued` with `available_at` set roughly one minute in the future. The worker will pick it up again on the next cycle after that delay. No manual action is needed.

**If the failure happens during or after the provider call** — the job is left as `status = failed`. Automatic re-queuing does not happen here, because the provider may have already received and accepted the message before the connection dropped. Re-queuing blindly could cause a double-send. Instead, the job is marked `retryable = true` (for transient errors like a network timeout or a 5xx response) or `retryable = false` (for permanent errors like an invalid address or authentication failure). A `retryable = true` job can be put back in the queue by a human via `RetryStandalone` or `RetryBatch` from your admin UI — see [Queueing](./queue#retrying-failed-jobs).

**If `BeforeSend` returns `mailing.ErrRejected`** — the provider is never called, and the job is permanently failed with `retryable = false`. It will never be retried, automatically or manually. This is intentional — `ErrRejected` means "do not send this".

Here is the full picture in one place:

| Outcome | `status` after | `retryable` | What happens next |
|---|---|---|---|
| Provider returns success | row deleted | — | Tracking row marked sent. Batch counters updated. |
| `BeforeSend` → `ErrRejected` | `failed` | `false` | Nothing. Permanently skipped. |
| `BeforeSend` → other error (< 3 attempts) | `queued` | — | Re-queued with ~1 min delay. Worker retries automatically. |
| `BeforeSend` → other error (3rd attempt) | `failed` | `false` | Nothing automatic. Not host-retryable. |
| Provider error, transient (< 3 attempts) | `failed` | `true` | Host calls `RetryStandalone` / `RetryBatch` to re-queue. |
| Provider error, transient (3rd attempt) | `failed` | `false` | No more retries. |
| Provider error, permanent | `failed` | `false` | No retries. Bad address, auth failure, etc. |

For provider selection rules, environment variables, and how to add a new provider, see the [Providers](./providers) page.
