---
title: Mailing
description: Database-backed outbound mail queue. Render in the host, send in the worker.
---

# Mailing

<Badge type="tip" text="Requires migration" />

The `mailing` package (`backend/mailing/`) handles outbound email. You give it a recipient address and a function that returns subject + HTML. The package writes a job row to PostgreSQL and returns immediately — no provider is contacted. A background worker picks up the job, calls Mailtrap or Mailgun, and deletes the row when the send succeeds.

The HTTP request **never** contacts the mail provider. That is intentional. If a user submits a form and your server times out, the email job is already committed to the database — the worker will send it. If you had called Mailgun directly from the handler, a timeout would leave you guessing whether the email was sent.

```
Your app
  handler receives request
  calls mailer.Queue(db, message)   ← renders HTML, inserts job row, returns
  handler returns response

Background worker (started at startup)
  claims job from mailing_jobs
  calls Mailtrap or Mailgun
  deletes job row on success
```

::: info What mailing does not do
The package does not render templates, choose who to email, check newsletter consent, serve unsubscribe pages, or register any HTTP routes. You write all of that. The package only stores what you give it and sends it.

It also does not keep a permanent log of sent mail. Successful job rows are deleted. If you need a permanent "sent email" table in your app, wire a `Logger` on the engine at startup — see [Worker](./worker#logger).
:::

---

## Step 1 — Publish and run the migration

The package ships its own SQL. Publish it into your migrations folder and apply it:

```sh
make -C backend/mailing migrate-publish
make migrate-up
```

This creates four tables:

| Table | What it stores |
|---|---|
| `mailing_jobs` | One row per queued email. Deleted when the send succeeds. |
| `mailing_batches` | One row per bulk send (`QueueBatch`). Tracks overall progress. |
| `mailing_recipients` | Optional open/click tracking rows. Only created when you opt in with `Track: true`. |
| `mailing_commands` | Optional idempotency ledger. Prevents double-sends when a client retries a request. |

You do not need to understand all four tables to send your first email. Full column detail is on the [Reference](./reference#tables) page.

---

## Step 2 — Set environment variables

```sh
# Appears in the From field of every email
MAIL_FROM_ADDRESS=noreply@example.com
MAIL_FROM_NAME=My App

# Provider selection:
#   Blank + APP_ENV=production  →  Mailgun
#   Blank + anything else       →  Mailtrap (safe: no real emails sent)
#   Set explicitly to override:   MAIL_PROVIDER=mailgun  or  MAIL_PROVIDER=mailtrap

# Mailtrap — for development
MAILTRAP_API_TOKEN=your_mailtrap_token
MAILTRAP_INBOX_ID=your_inbox_id

# Mailgun — for production
# MAILGUN_DOMAIN=mg.example.com
# MAILGUN_PRIVATE_KEY=your_mailgun_key
```

`EMAIL_SEND_DELAY_MS` (default `250`) is a pause between sends inside one worker cycle, to avoid flooding the provider during a large batch. All provider env vars and selection rules are on the [Worker](./worker#providers) page.

---

## Step 3 — Build the engine and start the worker

`mailing.New` builds an `Engine`. Call it once in `main.go` and pass the result into every handler or job that needs to queue an email.

```go
mailer := mailing.New(mailing.Config{
    OpenDB: db.GetConnection,
})

mailer.Start()
defer mailer.Stop()
```

`OpenDB` is the only required field. The worker calls it each time it wakes to open its own fresh database connection — it never shares the request's `*gorm.DB`.

Two optional hooks you can add to `Config`:

- `BeforeSend func(db *gorm.DB, job *mailing.Job) error` — called just before the provider is contacted, once per job. Use it to cancel a send if conditions have changed since queue time (e.g. the user unsubscribed). Return `mailing.ErrRejected` to skip permanently. Full details on the [Worker](./worker#beforesend) page.
- `Logger mailing.Logger` — called after every send attempt, success or failure. Use it to write a permanent sent-mail record to your own table. Full details on the [Worker](./worker#logger) page.

---

## Step 4 — Queue an email

Both sending paths — one recipient or many — work through the same idea: you describe the email, the package inserts job rows, the worker sends them. Which function you call depends on how many recipients you have.

### One recipient — mailer.Queue

`mailer.Queue` inserts a single `mailing_jobs` row, signals the worker, and returns. The provider is not contacted yet.

It takes two arguments: the `*gorm.DB` connection for the insert (can be an active transaction — if that transaction rolls back, the job is never committed), and a `mailing.Message` that describes the email.

`mailing.Message` has three required fields:

- `Type` — a string label you choose for this kind of email, e.g. `"welcome"`, `"password_reset"`, `"invoice"`. The package stores it on the job row but never interprets it. You use it in `BeforeSend` or `Logger` to know what kind of email is being processed.
- `To` — the recipient email address.
- `Render` — a function you write that returns the subject line and full HTML body. It is called **inside the queue transaction**, before the row is inserted. If it returns an error, the transaction rolls back and no job is stored.

`Render` receives two arguments. `r mailing.Recipient` carries the email address and any optional fields (like `UserID`) you attached to the recipient. `ids mailing.IDs` carries tracking UUIDs when you enable open/click tracking — for a plain email you can ignore it entirely.

```go
job, created, err := mailer.Queue(db, mailing.Message{
    Type: "welcome",
    To:   user.Email,
    Render: func(r mailing.Recipient, ids mailing.IDs) (string, string, error) {
        subject := "Welcome to the app"
        html    := "<p>Hi " + r.Email + ", glad you're here!</p>"
        return subject, html, nil
    },
})
if err != nil {
    return fmt.Errorf("queue welcome email: %w", err)
}
```

What comes back:

- `job` — the `mailing_jobs` row that was just inserted. It is **deleted** from the database once the worker sends it successfully, so do not store it expecting it to stay.
- `created` — always `true` for a plain `Queue` call. Only `false` when you use a `CommandID` for replay protection — explained on the [Queueing](./queue#preventing-double-sends-on-a-single-email) page.
- `err` — non-nil means the job was not stored. Nothing will be sent.

### Many recipients — mailer.QueueBatch

When one action should email a list of people — a newsletter, a digest, an announcement — use `mailer.QueueBatch` instead of calling `Queue` in a loop. It inserts one job per recipient in a single transaction and tracks overall progress on a `mailing_batches` row.

`mailing.BatchInput` has these required fields:

- `CommandID` — a UUID you generate and store on your own record (e.g. on the announcement row). If the HTTP request is retried after a network drop, you pass the same `CommandID` again. The package finds the existing batch and returns it with `created == false` instead of inserting a second round of jobs — this is what prevents your audience from being emailed twice. Full explanation on the [Queueing](./queue#preventing-double-sends--commandid) page.
- `Type` — same as on `Message`: a string label for this kind of email.
- `Recipients` — a slice of `mailing.Recipient`, each with at minimum an `Email` field. Duplicates are removed automatically. Empty addresses are skipped.
- `Render` — same signature as on `Message`. Called once per recipient, inside the transaction.

```go
batch, created, err := mailer.QueueBatch(db, mailing.BatchInput{
    CommandID:  announcement.SendCommandID,
    Type:       "digest",
    SourceID:   fmt.Sprint(announcement.ID),
    Recipients: []mailing.Recipient{
        {Email: "ada@example.com"},
        {Email: "linus@example.com"},
    },
    Render: func(r mailing.Recipient, ids mailing.IDs) (string, string, error) {
        subject := "This week's digest"
        html    := "<p>Hi " + r.Email + "</p>"
        return subject, html, nil
    },
})
if err != nil {
    return fmt.Errorf("queue digest batch: %w", err)
}
```

Batch jobs use a lower priority than standalone `Queue` jobs, so transactional emails (password resets, invoices) are never stuck behind a newsletter. Full `QueueBatch` options — tracking, hooks, expected count — are on the [Queueing](./queue) page.

---

## What happens after queuing

1. The job row sits in `mailing_jobs` with `status = queued`.
2. The worker wakes up — either immediately (signalled by `Queue`), or within 5 seconds on its poll.
3. It picks up the job, optionally calls your `BeforeSend` hook, then calls the provider.
4. On success, the job row is **deleted**.
5. On a retryable failure, the job is rescheduled with a delay. After 3 failed attempts it is left as `failed`.

You do not write any of that loop. The `mailer.Start()` call you made in Step 3 is all it takes — the worker runs in the background for the lifetime of your process.

---

## What's next

| Page | What you'll find |
|---|---|
| [Queueing](./queue) | `QueueBatch` options in full, preventing double-sends, tracking opens and clicks, unsubscribe tokens, retrying failed jobs |
| [Worker](./worker) | `BeforeSend`, `Logger`, retry logic, provider selection, adding a new provider |
| [Reference](./reference) | Every function signature, error values, and full table schema |
| [Testing](./testing) | In-memory helpers: `testutil.OpenTestDB`, `testutil.NewEngine` |
