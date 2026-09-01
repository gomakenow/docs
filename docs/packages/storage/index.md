---
title: Storage
description: Local disk and S3 drivers for object storage. Configure once at startup, inject everywhere.
---

# Storage

<Badge type="info" text="No migrations required" />

The `storage` package (`backend/storage/`) is the **low-level driver layer** for object storage. It does one thing: move bytes in and out of a storage backend. It knows nothing about the database, nothing about users, nothing about business logic. It just puts files somewhere and gets them back.

You configure it through environment variables. You call `storage.InitDrivers()` once at startup. You get back a `storage.Drivers` struct that holds every initialized driver. You pass that struct into any handler that needs to store or retrieve files. That is the entire lifecycle of the storage package from the outside.

::: info What storage does not do
The storage package has **no database interaction**. It does not insert rows or track which files belong to which user. It does not validate image formats, compress images, or enforce file size limits. It does not register HTTP routes.

Those stay in your app. You pick a driver, `Put` the bytes, and — if the file is private — write the handler that verifies the signed URL and serves it.
:::

---

## Environment variables

At a minimum you need these variables in your `.env` file. Both local drivers are always required regardless of whether you use S3.

```sh
# The base URL of your app — used to build file URLs
APP_URL=http://localhost:8003

# Where public files are stored on disk, and what URL path serves them
STORAGE_LOCAL_PUBLIC_ROOT_DIR=/var/data/storage/public
STORAGE_LOCAL_PUBLIC_URL=/storage/public

# Where private files are stored on disk, what URL path the download handler sits at,
# and the secret key used to sign download URLs
STORAGE_LOCAL_PRIVATE_ROOT_DIR=/var/data/storage/private
STORAGE_LOCAL_PRIVATE_URL=/storage/private
STORAGE_LOCAL_PRIVATE_SIGNING_KEY=some-random-signing-key
```

The public and private root directories must be different paths. The full reference is on the [Configuration](./configuration) page.

For S3, list bucket names **and** set one shared endpoint plus credentials. Without the credentials, `InitDrivers()` fails as soon as a bucket list is non-empty:

```sh
STORAGE_S3_BASE_URL=https://s3.example.com
STORAGE_S3_REGION=eu-central
STORAGE_S3_ACCESS_KEY=...
STORAGE_S3_SECRET_KEY=...

# Files in these buckets are served with direct public URLs
STORAGE_S3_BUCKETS_PUBLIC=my-public-bucket

# Files in these buckets are served with temporary presigned URLs
STORAGE_S3_BUCKETS_PRIVATE=my-private-bucket
```

::: warning Your S3 dashboard must match
The public/private split here must match how you configured the actual bucket in your S3 dashboard. If your bucket is set to block all public access in S3 but you list it under `STORAGE_S3_BUCKETS_PUBLIC`, file URLs will return 403 errors. Likewise, a bucket left publicly accessible in S3 while listed under private gives a false sense of access control — anyone with the key can access the file without a signed URL. Set the bucket ACL in your S3 dashboard first, then declare it in the matching env variable.
:::

---

## Initializing all drivers

This is the normal path for an application. `storage.InitDrivers()` reads the environment, builds every configured driver at once, and returns them all in a single `storage.Drivers` struct.

Call it once in `main.go` and inject `sd` into every handler that needs it:

```go
// main.go

sd, err := storage.InitDrivers()
if err != nil {
    log.Fatalf("Failed to initialize storage drivers: %v", err)
}

// pass sd into handlers that need to store or retrieve files
handlers.NewUploadHandler(sd)
```

If anything is wrong — a missing variable, a path collision, duplicate bucket names — it returns an error and the app refuses to start. There is no partial initialization.

`sd` is a `storage.Drivers` struct — a bag of initialized backends, one per configured storage location:

```go
type Drivers struct {
    LocalPublic  drivers.StorageDriver  // local disk, public
    LocalPrivate drivers.StorageDriver  // local disk, private
    S3ByBucket   map[string]drivers.StorageDriver  // one entry per configured bucket
}
```

```
storage.Drivers
 ├── LocalPublic   → local disk, public,  URL() gives a direct link
 ├── LocalPrivate  → local disk, private, SignedURL() gives a time-limited link
 └── S3ByBucket
      ├── "my-public-bucket"  → S3 bucket, public,  URL() gives a direct link
      └── "my-private-bucket" → S3 bucket, private, SignedURL() gives a presigned link
```

Every entry implements the same interface — `Put`, `Get`, `Delete`, `URL`, `SignedURL`. You pick the right one for the job and call it.

For S3 buckets, use `sd.LookupS3("bucket-name")` to get the driver — do not access `S3ByBucket` directly.

---

## Initializing a single driver

If you only need one driver — for a standalone tool, a migration script, or a test — you can initialize just that one without touching the rest of the config:

```go
// Local public driver only
driver, err := storage.LocalPublicStorage()

// Local private driver only
driver, err := storage.LocalPrivateStorage()

// One specific S3 bucket — true = public, false = private
driver, err := storage.S3Storage(false, "my-private-bucket")
```

Each function reads and validates only the env vars it needs. Everything else is ignored. The returned `driver` implements `StorageDriver` — same interface, same method calls as any driver from `InitDrivers()`.

---

## Storing and retrieving files

Once you have a driver — whether from `InitDrivers()`, or one you built directly with `LocalPublicStorage()` / `LocalPrivateStorage()` / `S3Storage()` — you use it the same way. Choose an object key (the path under which the bytes are stored) and call `Put`. Read the bytes back with `Get`. Remove them with `Delete`.

**Public driver** — stores the file and gives back a direct URL anyone can open:

```go
objectKey := "avatars/user-42.png"

// Writes the file to disk at:
//   /var/data/storage/public/avatars/user-42.png
err := driver.Put(objectKey, fileBytes)
if err != nil {
    // handle error
}

// Get the direct URL to hand back to the client
url := driver.URL(objectKey)
// → "http://localhost:8003/storage/public/avatars/user-42.png"
```

**Private driver** — no permanent URL exists. You generate a temporary link on demand; after it expires the link is dead and the client must request a new one:

```go
objectKey := "reports/user-42/export.csv"

// Writes the file to disk at:
//   /var/data/storage/private/reports/user-42/export.csv
err := driver.Put(objectKey, fileBytes)
if err != nil {
    // handle error
}

// Generate a temporary link — valid for 15 minutes, then it stops working
signedURL, err := driver.SignedURL(objectKey, 15*time.Minute)
// → "http://localhost:8003/storage/private/?path=reports%2Fuser-42%2Fexport.csv&exp=1751234567&sig=<hmac>"
```

When using `InitDrivers()`, access local drivers directly from `sd` and S3 drivers via `LookupS3`:

```go
// Local drivers
driver := sd.LocalPublic
driver := sd.LocalPrivate

// S3 driver for a specific bucket
driver, err := sd.LookupS3("my-private-bucket")
```

---

## What's next

| Page | What you'll find |
|---|---|
| [Drivers](./drivers) | Full `StorageDriver` interface, public vs private, local driver internals, S3 driver internals |
| [Configuration](./configuration) | Every env variable, validation rules, `InitDrivers()` step by step |
| [Advanced](./advanced) | `helpers.BuildPath`, shard directories, path traversal protection, HMAC signing internals, adding a new driver |
