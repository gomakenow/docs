---
title: Reference — Mailing
description: Every function signature, error value, and table schema for the mailing package.
---

# Reference

Full API signatures, error values, and database schema for the `mailing` package. For a walkthrough of how to use the package, start with [Getting started](./).

---

## mailing.New

Creates and returns an `Engine`. You call this once in `main.go` and pass the result around.

```go
func New(cfg Config) *Engine

type Config struct {
    // Required for the worker. Called each time the worker wakes to open
    // a fresh database connection.
    OpenDB func() (*gorm.DB, error)

    // Optional. Defaults to providers.NewGateway() (Mailgun + Mailtrap).
    // In tests, inject a fake gateway to avoid real provider calls.
    Gateway providers.Gateway

    // Optional. Called after every provider attempt (success or failure).
    // Use this to write a permanent sent-mail log in your app.
    // See Worker page for details.
    Logger Logger

    // Optional. Called after a job is claimed but before the provider is called.
    // Return mailing.ErrRejected to skip the send permanently.
    // See Worker page for details.
    BeforeSend func(db *gorm.DB, job *Job) error
}
```

`mailing.Default()` returns a lazily-constructed engine using an empty `Config`. `mailing.SetDefault(e)` replaces it. Both are package-level shortcuts. Prefer `mailing.New` and injection.

---

## Engine methods

```go
// Starts the background worker goroutine. Call once at startup.
func (e *Engine) Start()

// Signals the worker to stop and waits for in-flight sends to finish.
// Call on application shutdown (e.g. defer mailer.Stop()).
func (e *Engine) Stop()

// Wakes the worker immediately. Queue and QueueBatch call this automatically.
// You rarely need to call Signal yourself.
func (e *Engine) Signal()
```

---

## mailing.Queue

Inserts a single email job. Returns immediately. The provider is not contacted.

```go
func (e *Engine) Queue(db *gorm.DB, msg Message) (job *model.Job, created bool, err error)
```

- `job` — the inserted row. `nil` on command replay after the job was already sent.
- `created` — `true` for a fresh insert; `false` on command replay.
- `err` — non-nil if the insert failed (validation error, DB error, command conflict).

```go
type Message struct {
    Type    string     // required. Host label for this kind of email.
    To      string     // required. Recipient email address.
    Render  RenderFunc // required. Returns subject and HTML.

    // Optional fields:
    From            string     // overrides MAIL_FROM_ADDRESS for this email
    SourceID        string     // host identity string stored on the job
    Context         string     // host variant label
    UserID          *int64     // opaque host user ID stored on the job
    SubscriptionID  *int64     // opaque host subscription ID
    Track           bool       // create a mailing_recipients row for open/click tracking
    UnsubscribeToken string    // passed to Render via ids.UnsubscribeToken
    Priority        *int       // override priority (default: 0 for standalone)
    CommandID       uuid.UUID  // enables replay; see Queueing page
    CommandFingerprint string  // required when CommandID is set; 64 hex chars
    Prepare         func(tx *gorm.DB) error // runs inside the queue transaction, before insert
}
```

---

## mailing.QueueBatch

Queues many emails in a single transaction. `CommandID` is required.

```go
func (e *Engine) QueueBatch(db *gorm.DB, in BatchInput) (batch *model.Batch, created bool, err error)

type BatchInput struct {
    CommandID  uuid.UUID          // required. Replay key. Generate once, store on your record.
    Type       string             // required. Email type label.
    SourceID   string             // optional. Host object ID (e.g. announcement ID).
    Context    string             // optional. Audience/variant label.
    Recipients []Recipient        // required. Non-empty after de-duplication.
    Render     RenderFunc         // required. Called once per recipient.

    // Optional:
    From          string          // overrides MAIL_FROM_ADDRESS
    Track         bool            // create mailing_recipients rows
    ExpectedCount int             // if set, must match unique recipient count
    Prepare       func(tx *gorm.DB) error                        // runs before job inserts
    Finalize      func(tx *gorm.DB, batch *model.Batch) error    // runs after job inserts
}
```

---

## RenderFunc

```go
type RenderFunc func(r Recipient, ids IDs) (subject string, html string, err error)
```

Called inside the queue transaction before the job row is inserted. Return an error to roll back the entire transaction.

```go
type Recipient struct {
    Email            string
    UserID           *int64
    SubscriptionID   *int64
    UnsubscribeToken string
    Extra            map[string]any // host-defined extras
}

type IDs struct {
    RecipientID      string // set when Track: true
    UnsubscribeToken string // copied from Recipient.UnsubscribeToken
}
```

---

## Batch and job lookup

```go
func (e *Engine) GetBatch(db *gorm.DB, id uuid.UUID) (*model.Batch, error)
func (e *Engine) GetBatchByCommand(db *gorm.DB, commandID uuid.UUID, emailType, sourceID, context string) (*model.Batch, error)
func (e *Engine) GetBatchByCommandID(db *gorm.DB, commandID uuid.UUID) (*model.Batch, error)
func (e *Engine) GetLatestBatch(db *gorm.DB, emailType, sourceID string) (*model.Batch, error)
```

---

## Retry

```go
// Re-queue a standalone failed job whose retryable == true.
func (e *Engine) RetryStandalone(db *gorm.DB, jobID uuid.UUID) (*model.Job, error)

// Re-queue all retryable failed jobs in a batch.
func (e *Engine) RetryBatch(db *gorm.DB, batchID uuid.UUID) (*model.Batch, error)
```

Both wake the worker. Return `ErrNotRetryable` if there is nothing to retry.

---

## Tracking helpers

```go
// Records the first open on a mailing_recipients row.
func MarkOpened(db *gorm.DB, recipientID string) (*model.Recipient, error)

// Records the first click on a mailing_recipients row.
func MarkClicked(db *gorm.DB, recipientID string) (*model.Recipient, error)

// Writes a 1×1 transparent GIF with no-cache headers. Use as the open-pixel response.
func WritePixel(w http.ResponseWriter)
```

---

## mailing.ErrRejected

```go
var ErrRejected = errors.New("mailing: delivery rejected")
```

Return this from `Config.BeforeSend` to permanently skip a job. The provider is not called. The job is finished as a non-retryable failure.

---

## Errors

```go
var (
    // Returned by GetBatch and similar when the row does not exist.
    ErrNotFound = errors.New("mailing batch not found")

    // Returned by QueueBatch when another queued/processing batch exists
    // for the same (email_type, source_id).
    ErrActive = errors.New("mailing batch is already active")

    // Returned by RetryStandalone / RetryBatch when there is nothing retryable.
    ErrNotRetryable = errors.New("mailing batch has no retryable failed jobs")

    // Returned by QueueBatch when Recipients is empty after de-duplication.
    ErrNoRecipients = errors.New("mailing batch has no recipients")

    // Returned by Queue when CommandID is set but CommandFingerprint is missing.
    ErrCommandFingerprint = errors.New("mailing command fingerprint is required")

    // Returned when the same CommandID is reused with a different fingerprint.
    ErrCommandMismatch = errors.New("mailing command ID belongs to a different delivery")

    // Returned when Queue is called without a CommandID in contexts that require one.
    ErrCommandRequired = errors.New("mailing command ID is required")

    // Rare: returned when a command uniqueness conflict cannot be resolved.
    ErrCommandConflict = errors.New("mailing command uniqueness conflict could not be resolved")
)
```

`CountChangedError` is a typed error returned by `QueueBatch` when `ExpectedCount` is set and the unique recipient count does not match:

```go
type CountChangedError struct {
    Expected int
    Actual   int
}
```

---

## Tables {#tables}

```
mailing_batches          mailing_commands
  command_id (unique)      command_id (PK)
  │                        └ queue_job_id (nullable, no FK — job may be deleted)
  │ jobs ON DELETE CASCADE
  ▼
mailing_jobs ──── tracking_id ────► mailing_recipients
  batch_id nullable                   (only when Track: true)
```

Host FK columns from your `users` or subscription tables belong in **your** migrations. This package never creates a `sent_emails` table.

### mailing_jobs

Temporary queue. Rows are **deleted** when a send succeeds.

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `batch_id` | NULL for standalone jobs. FK → `mailing_batches` ON DELETE CASCADE. |
| `email_type` | The `Type` string you passed to `Queue` / `QueueBatch`. |
| `priority` | `0` for standalone (transactional), `100` for batch. Worker claims lower first. |
| `recipient` | Email address. Required. |
| `from_address` | From address for this job. Falls back to `MAIL_FROM_ADDRESS`. |
| `user_id` / `subscription_id` | Optional opaque host integers. |
| `subject` / `body_html` | Rendered at queue time by `RenderFunc`. |
| `source_id` | Optional host identity string. |
| `context` | Optional variant/audience label. |
| `tracking_id` | UUID of the `mailing_recipients` row. NULL when `Track: false`. |
| `status` | `queued` → `processing` → deleted (success) or `failed` |
| `attempts` | Incremented on each attempt. Max 3. |
| `retryable` | Whether a host retry call is possible. |
| `last_error` | Last error message from the provider. |
| `provider_started_at` | Set when `Gateway.Send` is about to be called. |
| `available_at` | The worker only claims rows where `available_at <= now`. |
| `reserved_at` | Set when the worker claims the job. |

### mailing_batches

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `command_id` | UNIQUE. Your replay key. |
| `email_type` / `source_id` / `context` | Replay identity together with `command_id`. |
| `status` | `queued` \| `processing` \| `complete` \| `partial` \| `failed` |
| `total_count` | Total number of jobs queued in this batch. |
| `sent_count` | Number successfully sent. |
| `failed_count` | Number that failed permanently. `sent + failed ≤ total` |
| `error` | Last job error text surfaced on the batch. |

At most one `queued` or `processing` batch per `(email_type, source_id)`. A second overlapping send returns `ErrActive`.

### mailing_recipients

Created only when `Track: true`. **Not deleted** when the job row is deleted.

| Column | Notes |
|---|---|
| `id` | UUID. Passed to `Render` as `ids.RecipientID`. Also stored as `job.tracking_id`. |
| `sent_successfully` | Set to true by the worker on success. |
| `sent_at` | Timestamp of the successful send. |
| `opened_at` | Timestamp of the first open event. |
| `clicked_at` | Timestamp of the first click event. |
| `purchased_at` / `order_id` | Host-written conversion fields. The package never fills these. |

### mailing_commands

Created only when `Queue` is called with a `CommandID`. Survives job deletion so replay works after a successful send.

| Column | Notes |
|---|---|
| `command_id` | Primary key. The UUID you passed. |
| `command_fingerprint` | 64 hex chars. Must match on replay. |
| `queue_job_id` | Set after insert. No foreign key — the job may be deleted. |
