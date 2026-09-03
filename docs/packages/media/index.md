---
title: Media
description: Atomic file uploads with database tracking. Upload, delete, and resolve URLs in one call.
---

# Media

<Badge type="tip" text="Requires migration" />

The `media` package (`backend/media/`) sits on top of the [storage](/packages/storage/) package and adds one layer on top: a database row for every file. Every uploaded file gets a `media` record that tracks which backend holds the bytes, where they live, and whether they are public or private. The rest of your app references files by `media.id` (a UUID) — never by a raw file path.

This separation means you can swap storage backends without touching feature code. You ask for a file by its UUID; the media package figures out where it lives and returns the right URL.

::: info What media does not do
`media` does not validate image formats, compress images, resize thumbnails, or enforce file size limits. That stays in your handler before you call `Upload`. The media package only coordinates: write bytes to storage, record where they went, and on demand return the URL to access them.
:::

---

## Step 1 — Publish and run the migration

The media package ships with its own migration file. Before you can use the package, publish that migration into your app's migrations folder and run it:

```sh
make -C backend/media migrate-publish
make migrate        # or however your app runs migrations
```

This creates the `media` table in your database:

```sql
CREATE TABLE IF NOT EXISTS public.media (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    storage    VARCHAR(32)  NOT NULL CHECK (storage IN ('local', 's3')),
    s3_bucket  VARCHAR(255),
    object_key TEXT         NOT NULL,
    is_public  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

| Column | What it holds |
|---|---|
| `id` | UUID primary key — the value you store on feature tables as the foreign key |
| `storage` | `"local"` or `"s3"` — which backend holds the bytes |
| `s3_bucket` | The bucket name for S3 files; empty for local files |
| `object_key` | The path within the backend, e.g. `avatars/user-42.png` |
| `is_public` | `true` → permanent direct URL; `false` → time-limited signed URL |
| `created_at` / `updated_at` | Managed by GORM |

No other tables are created. No foreign keys are owned by this package. Feature tables create FKs pointing **at** `media.id` — not the other way around.

---

## Step 2 — Add a media FK column to your feature table

Feature tables reference files by storing the `media.id` UUID in a column. Add the column with a foreign key constraint:

```sql
ALTER TABLE users
  ADD COLUMN profile_photo_id UUID REFERENCES media(id) ON DELETE SET NULL;
```

Use `ON DELETE SET NULL`, not `ON DELETE CASCADE`. When a `media` row is deleted, the feature column becomes `NULL` — the feature row itself stays. A user with no photo is better than a deleted user.

The column is typically nullable so the feature row can exist before any file is attached.

---

## Step 3 — Implement MediaRefs on your model

The orphan cleanup job (covered in [Orphan cleanup](./orphans)) scans the `media` table looking for rows that are no longer referenced by any feature column. For it to do that correctly, every model that has a `media.id` FK column must declare those columns by implementing `MediaRefs()`:

```go
// models/user.go

type User struct {
    ID             uuid.UUID  `gorm:"type:uuid;primaryKey"`
    Name           string
    ProfilePhotoID *uuid.UUID `gorm:"type:uuid"` // nullable FK pointing at media.id
}

// MediaRefs tells the orphan cleanup job which columns on this model hold media.id values.
func (User) MediaRefs() []media.Ref {
    return []media.Ref{
        {Table: "users", Column: "profile_photo_id"},
    }
}
```

`Table` is the exact database table name. `Column` is the exact database column name — not Go field names.

A model can have more than one media column. Return all of them:

```go
func (Product) MediaRefs() []media.Ref {
    return []media.Ref{
        {Table: "products", Column: "featured_image_id"},
        {Table: "products", Column: "thumbnail_image_id"},
    }
}
```

Place `MediaRefs()` immediately after the struct definition, before any other method.

::: warning Every column must be registered
If a column that holds `media.id` values is missing from `MediaRefs`, the cleanup job will treat the rows it references as orphans and eventually delete those files — even if they are actively in use. Register every `media.id` column.
:::

---

## Step 4 — Call media.Register at startup

Once your models implement `MediaRefs()`, pass them to `media.Register` once at application startup, before any request is served and before the cleanup job runs. This populates the internal registry that `FindOrphans` reads.

```go
// main.go

media.Register(
    models.User{},
    models.Product{},
)
```

`Register` accepts any number of models in one call. It is safe to call from multiple goroutines.

---

## Step 5 — Upload a file

`media.Upload` writes the bytes to storage first, then inserts the `media` row. If the DB insert fails after the bytes are already written, it deletes the bytes before returning the error — so you never end up with a file sitting in storage that nothing in the database knows about.

What each argument does:

- `db` — your GORM database connection; can be an active transaction
- `driver` — a `StorageDriver` from the [storage package](/packages/storage/). You get one from the `storage.Drivers` struct returned by `storage.InitDrivers()` at startup (e.g. `sd.LocalPublic`, `sd.LocalPrivate`, or `sd.LookupS3("bucket-name")`). **The driver you pick sets the visibility** — public driver → public file, private driver → private file. That flag is copied from the driver onto the `media` row; you never set it yourself.
- `objectKey` — the path to store the file at, e.g. `"avatars/user-42.png"`. You choose the convention. Never use a client-supplied filename — always build a UUID-based key.
- `data` — the raw file bytes, e.g. from `io.ReadAll(r.Body)` or a multipart form read

```go
// sd is your storage.Drivers from storage.InitDrivers().
// Picking LocalPublic makes this a public file.
driver := sd.LocalPublic

objectKey := "avatars/user-42.png"

// fileBytes is the raw file content, e.g. from io.ReadAll(r.Body)
// or by reading the multipart form file in your HTTP handler.
m, err := media.Upload(db, driver, objectKey, fileBytes)
if err != nil {
    http.Error(w, "upload failed", http.StatusInternalServerError)
    return
}

// m is the newly created media row.
// Store m.ID on your feature row as the foreign key.
user.ProfilePhotoID = &m.ID
if err := db.Save(&user).Error; err != nil {
    // handle — the file and media row both exist, only the feature row update failed
}
```

For S3, look up the driver for the bucket first, then pass it to `Upload` the same way:

```go
driver, err := sd.LookupS3("my-public-bucket")
if err != nil {
    // bucket not configured in env
}
m, err := media.Upload(db, driver, objectKey, fileBytes)
```

---

## Step 6 — Resolve a URL

`media.ResolveURL` looks at `m.IsPublic` on the row and returns the right kind of URL without you needing to know which backend the file is on. It reads `m.Storage` and `m.S3Bucket`, finds the correct driver, and calls the right method.

- **Public file** → returns a permanent direct URL (or CDN URL if configured). Never expires.
- **Private file** → returns a signed URL valid for `privateTTL`. Once that duration elapses the link is dead; call `ResolveURL` again to get a fresh one.

What each argument does:

- `sd` — the `storage.Drivers` struct returned by `storage.InitDrivers()` at startup
- `m` — the `*media.Media` row for the file; load it from DB using the UUID stored on the feature row
- `privateTTL` — how long a private URL stays valid; ignored entirely for public files

```go
// Load the media row. The UUID comes from the feature row —
// e.g. user.ProfilePhotoID was set when the file was uploaded.
m, err := mediamodel.GetByID(db, *user.ProfilePhotoID)
if err != nil {
    http.NotFound(w, r)
    return
}

url, err := media.ResolveURL(sd, m, 15*time.Minute)
if err != nil {
    http.Error(w, "could not resolve URL", http.StatusInternalServerError)
    return
}
// Public file:  url = "https://cdn.example.com/avatars/user-42.png"  (permanent)
// Private file: url = "https://s3.example.com/...?X-Amz-Expires=900&..."  (15 min)
```

---

## Step 7 — Delete a file

`media.Delete` resolves the correct storage driver internally from `sd`, removes the bytes from storage first, then deletes the `media` row.

Storage is deleted first. If the storage delete fails and the file still exists, the DB row is kept so the operation can be retried. If the file is already gone (`os.ErrNotExist`), the DB row is still removed.

What each argument does:

- `db` — your GORM database connection; can be an active transaction
- `sd` — the `storage.Drivers` struct returned by `storage.InitDrivers()` at startup; `Delete` calls `ForMedia` internally to pick the right driver from the row
- `id` — the `media.id` UUID to delete; must not be `uuid.Nil`

```go
err = media.Delete(db, sd, *user.ProfilePhotoID)
if err != nil {
    if errors.Is(err, mediamodel.ErrNotFound) {
        // row is already gone — nothing to do
    }
    // handle other errors (storage failure, driver not found, etc.)
}

// Clear the FK on the feature row
user.ProfilePhotoID = nil
db.Save(&user)
```

---

## What's next

| Page | What you'll find |
|---|---|
| [Orphan cleanup](./orphans) | What orphans are, how the registry works, `FindOrphans`, and running the job |
| [Reference](./reference) | Every function signature, parameters, and error behaviour |
| [Testing](./testing) | testutil helpers: `OpenTestDB`, `BeginTx`, `MockStorageDriver` |
