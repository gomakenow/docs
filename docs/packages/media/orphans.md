---
title: Orphan cleanup — Media
description: How orphaned media rows accumulate, how the registry tracks references, and how to run the cleanup job.
---

# Orphan cleanup

Every uploaded file creates a `media` row and writes bytes to storage. If the feature row that was supposed to reference that file is never saved — a cancelled request, a replaced photo, a bug — the `media` row has no referrer left. That row is an orphan: it costs storage space and clutters the table, but nothing in the app uses it.

This page explains how orphans accumulate, how the package detects them through a registry of known FK columns, and how to run the background job that cleans them up.

---

## What is an orphan?

Every call to `media.Upload` does two things: it writes bytes to storage and inserts a `media` row. After `Upload` returns, the caller is expected to save the new `media.id` onto a feature row — for example:

```go
m, err := media.Upload(db, driver, objectKey, fileBytes)
// ...
user.ProfilePhotoID = &m.ID
db.Save(&user)   // ← this second step must happen
```

If that second step never happens — the request timed out, the user cancelled the form, an error caused an early return — the `media` row now exists and the bytes are in storage, but nothing in the application references the ID. That row is an **orphan**.

Orphans also happen intentionally. When a record is updated to point at a new file, the old `media` row may be de-referenced — nothing in the application holds its ID anymore, and it is left for the cleanup job to collect.

These rows accumulate silently. They take up storage space, cost money, and clutter the `media` table. Left unmanaged, a high-traffic application can accumulate thousands of orphaned files per day.

---

## How the registry tracks references

To know whether a `media` row is still referenced, the cleanup job checks every `(table, column)` pair in its registry. If none of those columns contain a given `media.id`, the row is an orphan.

You populate the registry by implementing `MediaRefs()` on each model and calling `media.Register` at startup. This is the same `Register` call described in [Getting started](./):

```go
// main.go

media.Register(
    models.User{},
    models.Product{},
)
```

Each model declares which of its columns hold `media.id` values:

```go
func (User) MediaRefs() []media.Ref {
    return []media.Ref{
        {Table: "users", Column: "profile_photo_id"},
    }
}

func (Product) MediaRefs() []media.Ref {
    return []media.Ref{
        {Table: "products", Column: "featured_image_id"},
        {Table: "products", Column: "thumbnail_image_id"},
    }
}
```

The registry is a flat list of `(Table, Column)` pairs. `Register` is safe to call from multiple goroutines — it is protected by a `sync.RWMutex` and is immutable after startup.

::: warning Every column must be registered
The cleanup job builds a `NOT EXISTS` query for every registered `(Table, Column)` pair. Any column that holds `media.id` values but is **not** registered will not appear in the query — the rows it references will pass the orphan check and the job will delete them, even if the files are actively in use.

Register every column that holds a `media.id` foreign key, including nullable optional ones.
:::

---

## How FindOrphans works

`media.FindOrphans` queries the `media` table for rows that are not referenced by anything in the registry. It takes three arguments: the database connection, an `olderThan` time (a cutoff — only rows created before this point are considered), and a row limit.

The cutoff is there for a reason explained below. For now, think of it as "only scan rows older than X" — rows newer than the cutoff are skipped entirely, regardless of whether they are referenced.

Internally `FindOrphans` builds a query like this:

```sql
SELECT * FROM media
WHERE media.created_at <= $1   -- $1 is the olderThan cutoff you pass in
  AND NOT EXISTS (SELECT 1 FROM users    WHERE users.profile_photo_id     = media.id)
  AND NOT EXISTS (SELECT 1 FROM products WHERE products.featured_image_id  = media.id)
  AND NOT EXISTS (SELECT 1 FROM products WHERE products.thumbnail_image_id = media.id)
ORDER BY media.created_at ASC
LIMIT $2;
```

One `NOT EXISTS` clause is added per registered `(Table, Column)` pair. `NOT EXISTS` is used instead of a `LEFT JOIN` to avoid duplicate rows when the same `media.id` is referenced by multiple rows in a single table. The query is index-friendly.

---

## Why the cutoff is required

An upload always has two steps:

1. `media.Upload` — bytes are written, `media` row is inserted
2. The caller saves the feature row with the new `media.id`

Between those two steps the `media` row exists but no feature column references it yet. If the cleanup job ran at that exact moment, it would find the row unreferenced and delete it — before the feature row was ever saved.

The `olderThan` cutoff prevents this. `FindOrphans` skips any row whose `created_at` is newer than the cutoff. A row must be **older than the cutoff** to be considered for deletion.

`FindOrphans` does not delete anything itself — it only returns the orphan rows. The actual deletion is done by `jobs.CleanupOrphans`, which calls `FindOrphans` internally and handles the storage and database cleanup. That is covered in the next section.

---

## Running the cleanup job

`jobs.CleanupOrphans` is not scheduled automatically. Your application is responsible for calling it on a recurring schedule. A goroutine with a ticker is the simplest approach.

The `Cutoff` config field maps directly to the `olderThan` argument passed to `FindOrphans`. It defaults to **1 hour**, which gives uploads a full hour to complete before they become eligible — far longer than any realistic request. If your app has unusually long multi-step flows where the feature row is saved minutes after `Upload`, increase it to match.

```go
// main.go (or wherever you set up background jobs)

import (
    "log/slog"
    mediajobs "go-jesse-trade/backend/media/jobs"
    mediamodel "go-jesse-trade/backend/media/model"
)

go func() {
    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()
    for range ticker.C {
        result := mediajobs.CleanupOrphans(db, sd, mediajobs.CleanupOrphansConfig{
            Cutoff:    2 * time.Hour,  // row must be older than 2h to be eligible
            BatchSize: 500,            // process at most 500 rows per run

            OnDeleted: func(m mediamodel.Media) {
                slog.Info("media orphan deleted", "id", m.ID, "key", m.ObjectKey)
            },
            OnError: func(err error) {
                slog.Error("media orphan cleanup error", "err", err)
            },
        })
        slog.Info("media orphan cleanup done",
            "scanned", result.Scanned,
            "deleted", result.Deleted,
            "skipped", result.Skipped,
            "failed", result.Failed,
        )
    }
}()
```

What `CleanupOrphans` does on each call:

1. Computes `cutoff = now − Cutoff` and calls `media.FindOrphans(db, cutoff, BatchSize)`.
2. For each orphan row, calls `media.Delete(db, d, m.ID)` — which resolves the correct driver internally, removes the bytes from storage, then deletes the DB row.
3. Calls `OnDeleted` or `OnError` depending on the outcome.
4. Moves to the next row regardless of errors — a single failure never stops the batch.
5. Returns a `CleanupOrphansResult` with totals.

If `Scanned == BatchSize`, there may be more orphans than the batch processed. The next scheduled run will process the remainder.

---

## Reading the result

`CleanupOrphansResult` tells you exactly what happened during the run:

```go
type CleanupOrphansResult struct {
    Scanned int  // total rows returned by FindOrphans
    Deleted int  // rows whose bytes and DB row were successfully removed
    Skipped int  // rows where the driver could not be resolved — left in place
    Failed  int  // rows where Delete failed after the driver was found — left in place
}
```

`Skipped` and `Failed` both leave the row in place and surface via `OnError`.

| Count | Meaning | What to do |
|---|---|---|
| `Skipped > 0` | `Delete` returned an error wrapping `media.ErrDriverNotFound` — the `storage` value is unknown, the S3 bucket name is not in env, or `is_public` on the row does not match the bucket's env config | Check `OnError` logs; usually a config change that was not reflected in env |
| `Failed > 0` | `Delete` failed for a reason other than driver resolution — transient storage error | Rows are kept; the next scheduled run retries them automatically |

Always wire `OnError` in production so these failures surface in your logs.
