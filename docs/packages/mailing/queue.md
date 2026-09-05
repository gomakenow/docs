---
title: Queueing — Mailing
description: Preventing double-sends, tracking opens and clicks, hooks, and retrying failed jobs.
---

# Queueing

[Getting started](./) showed how to call `mailer.Queue` for one recipient and `mailer.QueueBatch` for many. This page covers the extras you can layer on top of both: preventing double-sends when a client retries a request, tracking opens and clicks, passing unsubscribe tokens into your template, running hooks inside the transaction, and retrying failed jobs.

---

## Additional QueueBatch options

Getting started showed the required fields. Here are the things that happen automatically, plus the optional fields worth knowing:

- Recipients are **de-duplicated** by lowercased email before any jobs are inserted. Duplicates in your list are silently dropped.
- Empty email strings are skipped.
- Zero unique recipients after de-duplication returns `ErrNoRecipients`.
- At most one `queued` or `processing` batch is allowed per `(Type, SourceID)` at a time. Starting a second overlapping send returns `ErrActive` — wait for the first to finish or fail before queuing again.
- `Context` is an optional string for labelling the audience variant (e.g. `"all_subscribers"`, `"free_tier"`). Stored on the batch row, never interpreted by the package.
- `ExpectedCount` is an optional safety check. If set, `QueueBatch` verifies that the number of unique recipients matches this number exactly before inserting anything. Use it to catch an audience query that returned different results between preview and send time — a mismatch returns `CountChangedError`.

---

## Preventing double-sends on a single email

The same problem can occur with a single email. For example: an admin clicks "Resend invoice" and the request times out. They click again. Should the customer get two invoices?

Use `CommandID` on `Queue` to prevent it. You also need to provide a `CommandFingerprint` — a 64-character hex string you compute from the payload (a SHA-256 of the email type + recipient + relevant IDs works well).

```go
// fingerprint uniquely identifies this specific email payload.
// Compute it yourself, e.g.: hex(sha256(type + recipient + invoiceID))
fingerprint := computeFingerprint("invoice_send", user.Email, invoice.ID)

job, created, err := mailer.Queue(db, mailing.Message{
    CommandID:          commandID,  // stored on your invoice row
    CommandFingerprint: fingerprint,
    Type:               "invoice_send",
    To:                 user.Email,
    Render:             renderFn,
})
```

What happens on the second call with the same `CommandID` + `Type` + fingerprint:

- If the job is still in the queue (not yet sent), `created == false` and `job` is the existing row.
- If the job was already sent and deleted, `created == false` and `job` is `nil`. The command record stays, so future retries still see "already done".

If you pass the same `CommandID` but a **different** fingerprint (different payload), you get `ErrCommandMismatch`. This protects you from accidentally replaying a different email under the same command ID.

---

## Tracking opens and clicks

Set `Track: true` on `Queue` or `QueueBatch`. The package inserts a `mailing_recipients` row for the recipient in the same transaction and passes its UUID into your `Render` function via `ids.RecipientID`.

```go
mailer.Queue(db, mailing.Message{
    Type:  "digest",
    To:    user.Email,
    Track: true,
    Render: func(r mailing.Recipient, ids mailing.IDs) (string, string, error) {
        // ids.RecipientID is a UUID string when Track is true.
        // Embed it in a pixel URL and/or a click-through URL.
        // Your HTTP handlers must handle these routes — the package does not register routes.

        openPixel := "https://example.com/mail/open/" + ids.RecipientID
        html := `<p>Hello</p>` +
            `<img src="` + openPixel + `" width="1" height="1" style="display:none" alt="">`
        return "Your digest", html, nil
    },
})
```

Your HTTP handler calls the package helpers when a pixel is loaded or a link is clicked:

```go
// GET /mail/open/{id}
recipientID := mux.Vars(r)["id"]
mailing.MarkOpened(db, recipientID) // records opened_at on the first open
mailing.WritePixel(w)               // writes a 1×1 transparent GIF with no-cache headers

// GET /mail/click/{id}?url=...
mailing.MarkClicked(db, recipientID) // records clicked_at on the first click
http.Redirect(w, r, destination, http.StatusFound)
```

Tracking rows survive job deletion — `mailing_recipients` rows are **not** cleaned up when the job succeeds. `sent_successfully` and `sent_at` are set by the worker when the send completes. `purchased_at` and `order_id` are host-written conversion fields; the package never touches them.

If `Track` is false, no `mailing_recipients` row is created and `ids.RecipientID` is an empty string.

---

## Unsubscribe tokens

The package does not manage consent or subscriptions. But if you already have an unsubscribe token in your database, you can pass it through so your `Render` function can build an unsubscribe link.

```go
mailing.Recipient{
    Email:            "ada@example.com",
    UnsubscribeToken: sub.Token, // your token, stored in your subscriptions table
}
```

Inside `Render`, access it via `ids.UnsubscribeToken`:

```go
Render: func(r mailing.Recipient, ids mailing.IDs) (string, string, error) {
    unsubLink := "https://example.com/unsubscribe?token=" + ids.UnsubscribeToken
    html := `<p>Hello</p><p><a href="` + unsubLink + `">Unsubscribe</a></p>`
    return "Hello", html, nil
},
```

Who is allowed to receive marketing mail is **your** responsibility before you call `QueueBatch`. If someone unsubscribes after the batch is queued but before the worker processes their job, catch it in `BeforeSend` — see [Worker](./worker#beforesend).

---

## Hooks that run inside the transaction

`Queue` and `QueueBatch` open a database transaction internally to insert the job rows. Sometimes you need your own database writes to happen in that same transaction — so that if anything fails, both your write and the job inserts roll back together, leaving no inconsistency.

Two hooks let you do this.

### Prepare

`Prepare` runs **before** the job rows are inserted, inside the open transaction. The `tx` it receives is the same transaction the package is using.

A common use case: you want to mark an announcement as `"sending"` at the same moment the jobs are queued. If you did this in two separate calls — update the announcement, then call `QueueBatch` — you could end up with the status updated but no jobs queued (or vice versa) if something fails between the two. With `Prepare`, both writes are in the same commit:

```go
batch, created, err := mailer.QueueBatch(db, mailing.BatchInput{
    CommandID:  announcement.SendCommandID,
    Type:       "digest",
    Recipients: recipients,
    Render:     renderFn,
    Prepare: func(tx *gorm.DB) error {
        return tx.Model(&announcement).Update("status", "sending").Error
    },
})
```

If `Prepare` returns an error, the transaction rolls back — no jobs are inserted and your update is also rolled back.

### Finalize

`Finalize` is only available on `QueueBatch`. It runs **after** all job rows have been inserted, but while the transaction is still open. It receives the newly created `mailing_batches` row, so you have access to its `ID`.

Use it when you need to write the batch ID back to your own record — for example, storing it on the announcement so you can look up the batch's progress later:

```go
batch, created, err := mailer.QueueBatch(db, mailing.BatchInput{
    CommandID:  announcement.SendCommandID,
    Type:       "digest",
    Recipients: recipients,
    Render:     renderFn,
    Finalize: func(tx *gorm.DB, batch *mailing.Batch) error {
        return tx.Model(&announcement).Update("batch_id", batch.ID).Error
    },
})
```

If `Finalize` returns an error, the transaction rolls back — the jobs are not committed and your update is also rolled back.

You can use `Prepare` and `Finalize` together if you need writes both before and after job insertion.

---

## Retrying failed jobs

Jobs that fail and still have `retryable == true` can be put back on the queue:

```go
// Retry a single standalone job by its ID
mailer.RetryStandalone(db, jobID)

// Retry all retryable failed jobs in a batch
mailer.RetryBatch(db, batchID)
```

Both wake the worker after re-queuing. If there is nothing retryable, you get `ErrNotRetryable`.
