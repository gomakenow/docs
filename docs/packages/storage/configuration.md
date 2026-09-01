---
title: Configuration — Storage
description: Environment variables, validation, and how InitDrivers reads them.
---

# Configuration

The storage package owns its own environment variables. They live under `STORAGE_*` (plus `APP_URL`) in `backend/storage/config.go`. They are not mixed into the rest of the app's config — the package reads them itself.

You put values in `.env` (or the process environment). The package never writes them, never has defaults for required fields, and never silently continues if something required is missing.

---

## How env is loaded

`LoadEnv()` reads the process environment and normalizes every value:

- Whitespace is trimmed.
- Base URLs (`APP_URL`, `STORAGE_S3_BASE_URL`, `STORAGE_S3_PUBLIC_BASE_URL`) lose a trailing slash.
- URL path suffixes (`STORAGE_LOCAL_PUBLIC_URL`, `STORAGE_LOCAL_PRIVATE_URL`) get a leading `/` and lose a trailing `/`.
- Bucket lists are split on commas and empty entries are dropped.

You almost never call `LoadEnv()` yourself. `InitDrivers()`, `LocalPublicStorage()`, `LocalPrivateStorage()`, and `S3Storage()` all call it internally, then validate the fields they need.

If a required value is empty or malformed, those functions return an error that names the exact variable. That is why a missing `.env` entry fails at startup instead of producing a broken URL later.

---

## Local storage

Both local drivers are required when you call `InitDrivers()`. A single-driver factory only validates the fields for that one driver.

### Always required for local

| Variable | Example | What it is |
|---|---|---|
| `APP_URL` | `http://localhost:8003` | Base URL of your app. Used to build file URLs (`APP_URL` + path prefix + object key). Must be `http://` or `https://`. No trailing slash. |

Without `APP_URL`, the local driver cannot produce a URL a client can open. That is why it is required even though files themselves live on disk.

### Public local

| Variable | Example | What it is |
|---|---|---|
| `STORAGE_LOCAL_PUBLIC_ROOT_DIR` | `/var/data/storage/public` | Directory on disk where public files are written. `Put("avatars/a.png", data)` writes `/var/data/storage/public/avatars/a.png`. |
| `STORAGE_LOCAL_PUBLIC_URL` | `/storage/public` | HTTP path prefix used by `URL()`. Combined with `APP_URL`, that file's URL is `http://localhost:8003/storage/public/avatars/a.png`. Must start with `/`. |

These two are a pair: the root dir is where bytes go, the URL prefix is how clients reach them. The storage package does not register an HTTP file server — you wire that in your app if you want the URL to actually serve the file.

### Private local

| Variable | Example | What it is |
|---|---|---|
| `STORAGE_LOCAL_PRIVATE_ROOT_DIR` | `/var/data/storage/private` | Directory on disk where private files are written. |
| `STORAGE_LOCAL_PRIVATE_URL` | `/storage/private` | HTTP path prefix used by `SignedURL()`. The signed URL is built as `APP_URL` + this prefix + query params. |
| `STORAGE_LOCAL_PRIVATE_SIGNING_KEY` | a long random secret | HMAC key used to sign and verify private download URLs. Anyone who has this key can mint a valid signed URL. Use a long, random value in production. |

Private files have no permanent URL. `SignedURL` uses these three values to produce a time-limited link. Your app still has to register a handler at `STORAGE_LOCAL_PRIVATE_URL` that verifies the signature and serves the file — see [Private local driver](./drivers#private-local-driver).

::: warning Public and private must not overlap
`STORAGE_LOCAL_PUBLIC_ROOT_DIR` and `STORAGE_LOCAL_PRIVATE_ROOT_DIR` must be **different directories**. `STORAGE_LOCAL_PUBLIC_URL` and `STORAGE_LOCAL_PRIVATE_URL` must be **different path prefixes**.

If the roots are the same, a private object is sitting in a directory you might serve as public. If the URL prefixes are the same, the public file server and the private download handler cannot tell whose request it is. `InitDrivers()` rejects both collisions before creating any driver.
:::

---

## S3

S3 is optional. If both bucket lists are empty, `InitDrivers()` still succeeds — you get local drivers only, and `LookupS3` will error if something later asks for a bucket.

All S3 buckets share **one** endpoint and **one** set of credentials. There is no per-bucket override.

### Credentials and endpoint

Required as soon as you list any bucket (public or private):

| Variable | Example | What it is |
|---|---|---|
| `STORAGE_S3_BASE_URL` | `https://s3.example.com` | S3-compatible endpoint. Scheme + host only — no path, no trailing slash. Used by the AWS SDK and as the fallback origin for public `URL()`. |
| `STORAGE_S3_REGION` | `eu-central` | Region string passed to the SDK. Required even for non-AWS providers. |
| `STORAGE_S3_ACCESS_KEY` | `AKIAIOSFODNN7EXAMPLE` | Static access key ID. |
| `STORAGE_S3_SECRET_KEY` | `wJalrXUtnFEMI...` | Static secret access key. |

If any of these is missing while a bucket list is non-empty, S3 driver construction fails and `InitDrivers()` fails with it.

### Bucket lists

These lists are how the package knows which buckets exist and whether each one is public or private:

| Variable | Example | What it is |
|---|---|---|
| `STORAGE_S3_BUCKETS_PUBLIC` | `my-public-bucket` | Comma-separated bucket names. Each becomes a public S3 driver. `URL()` returns a direct link. |
| `STORAGE_S3_BUCKETS_PRIVATE` | `my-private-bucket` | Comma-separated bucket names. Each becomes a private S3 driver. `SignedURL()` returns a presigned link. |

A name in neither list is not initialized. `LookupS3("that-name")` then returns an error telling you to add it to one of the lists.

The same name must not appear in both lists, and must not be duplicated inside one list. That collision is checked **before** any S3 driver is created.

::: warning S3 dashboard must match the list
Listing a bucket as public in env does not make the bucket public in S3. If the bucket blocks public access in the S3 dashboard, `URL()` still produces a public-looking link — the request then 403s.

Listing a bucket as private does not hide objects if the bucket is publicly readable in S3. Anyone with the object key can fetch it without a signed URL.

Configure the bucket ACL in your S3 dashboard first, then put the name in the matching env list.
:::

### Optional CDN

| Variable | Example | What it is |
|---|---|---|
| `STORAGE_S3_PUBLIC_BASE_URL` | `https://cdn.example.com` | Optional. When set, public S3 `URL()` returns `<cdn>/<key>` instead of `<endpoint>/<bucket>/<key>`. Must be a valid `http://` or `https://` URL. |

This assumes the CDN root maps to the public bucket's root — there is no bucket segment in the URL. It is applied to **every** public S3 driver, so it only makes sense when you have a single public bucket.

Private drivers ignore this variable. Presigned URLs always come from the S3 endpoint.

---

## What InitDrivers does with this config

`InitDrivers()` is the all-at-once path. It loads env once, then builds every driver:

1. **Load env** — `LoadEnv()` as described above.
2. **Reject duplicate bucket names** — a name in both lists, or twice in one list, fails immediately. No drivers are created.
3. **Local public** — `ValidateForLocalPublic()`, then construct the driver. Missing `APP_URL`, missing public root/URL, or a public/private collision fails here.
4. **Local private** — `ValidateForLocalPrivate()`, then construct the driver. Missing signing key or the same collision fails here.
5. **Public S3 buckets** — for each name in `STORAGE_S3_BUCKETS_PUBLIC`, `ValidateForS3()` then `S3Storage(true, name)`. First failure stops everything.
6. **Private S3 buckets** — same for `STORAGE_S3_BUCKETS_PRIVATE` with `S3Storage(false, name)`.
7. **Log a summary** — which local drivers are active and which S3 buckets were wired.

On any failure it returns `(Drivers{}, error)`. Partial initialization never happens: either every listed driver is ready, or none of them are.

Each error names the variable at fault:

```
storage: STORAGE_LOCAL_PUBLIC_ROOT_DIR is required for local_public (set it in your .env file)
storage: STORAGE_LOCAL_PUBLIC_ROOT_DIR and STORAGE_LOCAL_PRIVATE_ROOT_DIR must differ (they cannot be the same path; check your .env file)
storage: bucket "my-bucket" appears in both STORAGE_S3_BUCKETS_PUBLIC and STORAGE_S3_BUCKETS_PRIVATE
```

Single-driver factories (`LocalPublicStorage`, `LocalPrivateStorage`, `S3Storage`) skip the other drivers. They still load the same env and run the matching `Validate*` method — they just do not require the rest of the config to be present.

---

## Validation methods

`StorageEnv` exposes three methods. `InitDrivers()` and the factories call them for you. You only need them if you want to check config without constructing a driver:

```go
env := storage.LoadEnv()

err := env.ValidateForLocalPublic()
err := env.ValidateForLocalPrivate()
err := env.ValidateForS3()
```

| Method | What it checks |
|---|---|
| `ValidateForLocalPublic` | `APP_URL`, public root dir, public URL prefix, plus the public/private collision rules |
| `ValidateForLocalPrivate` | `APP_URL`, private root dir, private URL prefix, signing key, plus the same collision rules |
| `ValidateForS3` | S3 endpoint URL, region, access key, secret key, and that `STORAGE_S3_PUBLIC_BASE_URL` is a valid URL if set |

`ValidateForS3` does **not** check the bucket lists. Duplicate buckets are a separate check inside `InitDrivers()`.
