---
title: Reference — Media
description: Full API reference for every media package function.
---

# Reference

Complete signatures, parameter tables, and error behaviour for every exported symbol in the `media` package. If you are looking for how to wire things together end to end, start with [Getting started](./) first.

---

## media.Upload

```go
func Upload(db *gorm.DB, driver drivers.StorageDriver, objectKey string, data []byte) (*mediamodel.Media, error)
```

Writes `data` to the storage backend at `objectKey`, then inserts a `media` row. Returns the created row on success.

If the DB insert fails, `Upload` calls `driver.Delete(objectKey)` as best-effort cleanup before returning the error — preventing a file in storage with no row to reference it.

| Parameter | Notes |
|---|---|
| `db` | Must not be nil. Can be an active transaction — `Upload` participates in it. |
| `driver` | The storage driver to write to. Its `IsPublic()` is copied onto `media.is_public`. Its `Type()` is copied onto `media.storage`. For S3 drivers, `BucketName()` is copied onto `media.s3_bucket`. |
| `objectKey` | The path within the backend. Never use a client-supplied filename directly — use a UUID-based key. |
| `data` | Must not be empty. |

**Errors** — returned when any guard check fails, when `driver.Put` fails (no DB side-effect), or when the DB insert fails (bytes are cleaned up).

---

## media.ErrDriverNotFound

```go
var ErrDriverNotFound = errors.New("media: driver not found")
```

Sentinel returned (wrapped) by `Delete` when `ForMedia` cannot resolve a driver — unknown backend, S3 bucket not in env, or `is_public` mismatch. The DB row is left in place.

Use `errors.Is(err, media.ErrDriverNotFound)` to distinguish driver-resolution failures from storage or DB failures — for example in `jobs.CleanupOrphans` to count `Skipped` rows separately from `Failed`.

---

## media.Delete

```go
func Delete(db *gorm.DB, sd storage.Drivers, id uuid.UUID) error
```

Resolves the storage driver from `sd` by reading the `media` row (via `GetByID`), then removes the bytes from storage and deletes the row.

Storage is deleted first. If the storage delete fails and the file still exists, the DB row is kept so the operation can be retried. If the file is already gone (`os.ErrNotExist`), the DB row is still removed.

| Parameter | Notes |
|---|---|
| `db` | Must not be nil. Can be an active transaction. |
| `sd` | The `storage.Drivers` struct from `storage.InitDrivers()`. `Delete` calls `ForMedia` internally to resolve the correct driver from the row. |
| `id` | Must not be `uuid.Nil`. |

**Errors**
- `model.ErrNotFound` — row does not exist
- Error wrapping `ErrDriverNotFound` — driver could not be resolved (unknown backend, bucket not in env, or `is_public` mismatch); DB row is left in place
- Storage errors (unless `os.ErrNotExist`) — DB row is left in place for retry
- DB delete errors — returned after storage has already been cleaned

---

## media.ForMedia

```go
func ForMedia(sd storage.Drivers, m *mediamodel.Media) (drivers.StorageDriver, error)
```

Returns the driver that owns the bytes for the given `media` row. `media.Delete` calls this internally, so most application code no longer needs to call it directly. It remains exported for cases where you need the driver for a reason other than deletion — for example, to call `Get` to read the bytes back out.

Resolution logic:

| `m.Storage` | `m.IsPublic` | Returns |
|---|---|---|
| `"local"` | `true` | `sd.LocalPublic` |
| `"local"` | `false` | `sd.LocalPrivate` |
| `"s3"` | either | `sd.LookupS3(m.S3Bucket)` |

For S3 rows, `ForMedia` also verifies that `driver.IsPublic() == m.IsPublic`. A mismatch means the bucket was reconfigured without updating existing rows — it returns an error rather than silently serving files from the wrong mode.

**Errors** — nil driver in `sd`, unknown `m.Storage` value, S3 bucket not found, or `IsPublic` mismatch. When returned by `Delete`, these errors are wrapped with `ErrDriverNotFound`.

---

## media.ResolveURL

```go
func ResolveURL(sd storage.Drivers, m *mediamodel.Media, privateTTL time.Duration) (string, error)
```

Returns the access URL for a media row:

- **Public** (`m.IsPublic == true`) → `driver.URL(m.ObjectKey)` — a permanent direct or CDN URL.
- **Private** (`m.IsPublic == false`) → `driver.SignedURL(m.ObjectKey, privateTTL)` — a time-limited URL that expires after `privateTTL`.

`privateTTL` is ignored for public files. Pass any non-zero duration.

Calls `ForMedia` internally to resolve the driver. Any error from `ForMedia` is returned.

---

## media.Register

```go
func Register(models ...Referrer)
```

Adds every model's `MediaRefs()` to the internal registry. Call once at application startup, before any request is served or the cleanup job runs.

Models must implement `Referrer`:

```go
type Referrer interface {
    MediaRefs() []Ref
}
```

`Ref` is a `(Table, Column)` pair — both must be exact database names:

```go
type Ref struct {
    Table  string  // e.g. "products"
    Column string  // e.g. "featured_image_id"
}
```

Register is safe to call from multiple goroutines (protected by a `sync.RWMutex`).

---

## media.FindOrphans

```go
func FindOrphans(db *gorm.DB, olderThan time.Time, limit int) ([]mediamodel.Media, error)
```

Returns media rows that are not referenced by any column in the registered registry **and** whose `created_at` is at or before `olderThan`. Results are ordered by `created_at ASC` (oldest first).

The `olderThan` cutoff prevents racing with in-flight uploads where the `media` row has been inserted but the referencing feature column has not yet been written. A cutoff of at least a few minutes is safe for most applications.

`limit ≤ 0` defaults to 100.

::: warning Register before FindOrphans
If `Register` was never called, the registry is empty. Every `NOT EXISTS` clause in the query passes — all rows appear orphaned and will be returned. Always call `Register` at startup before the cleanup job runs.
:::

---

## media.model.GetByID

```go
func GetByID(db *gorm.DB, id uuid.UUID) (*Media, error)
```

Looks up a `media` row by primary key. Returns `model.ErrNotFound` (not a GORM `ErrRecordNotFound`) when the row does not exist — use `errors.Is(err, mediamodel.ErrNotFound)` to check.

---

## jobs.CleanupOrphans

```go
func CleanupOrphans(db *gorm.DB, d storage.Drivers, cfg CleanupOrphansConfig) CleanupOrphansResult
```

Runs one batch of orphan cleanup: finds rows via `FindOrphans`, resolves each driver via `ForMedia`, then calls `media.Delete` for each one. The full result is returned regardless of per-row failures.

### CleanupOrphansConfig

```go
type CleanupOrphansConfig struct {
    Cutoff    time.Duration          // default: 1 hour
    BatchSize int                    // default: 500
    OnDeleted func(m Media)          // optional — called after each successful delete
    OnError   func(err error)        // optional — called on each per-row error (run continues)
}
```

| Field | Default | Notes |
|---|---|---|
| `Cutoff` | `1 hour` | How old a row must be to be eligible. Prevents racing with in-flight uploads. |
| `BatchSize` | `500` | Max rows processed per run. Run the job again to process more. |
| `OnDeleted` | `nil` | Hook for logging or metrics per deleted row. |
| `OnError` | `nil` | Hook for logging per-row failures. The run continues regardless. |

### CleanupOrphansResult

```go
type CleanupOrphansResult struct {
    Scanned int
    Deleted int
    Skipped int  // driver could not be resolved; row left in place
    Failed  int  // driver resolved but Delete failed; row left in place
}
```

`Skipped` and `Failed` both leave the row in place. `Skipped` means `ForMedia` errored (unknown backend or misconfigured bucket). `Failed` means `Delete` errored (transient storage failure). Both surface via `OnError`.

A `Scanned` count with zero `Deleted` and non-zero `Skipped` or `Failed` usually means a misconfigured bucket or a bucket that was removed from env — check the errors from `OnError`.
