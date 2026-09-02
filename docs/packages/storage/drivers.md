---
title: Drivers — Storage
description: The StorageDriver interface, public vs private, local disk driver, and S3 driver.
---

# Drivers

Every storage backend — local disk, S3, or any future provider — implements the same `StorageDriver` interface. Once you have a driver, you use it the same way regardless of where files actually go. The differences between backends are entirely encapsulated inside the driver.

---

## The StorageDriver interface

Defined in `backend/storage/drivers/driver.go`:

```go
type StorageDriver interface {
    Put(path string, data []byte) error
    Get(path string) ([]byte, error)
    Delete(path string) error
    URL(path string) string
    SignedURL(path string, ttl time.Duration) (string, error)
    IsPublic() bool
    Type() StorageDriverType
}
```

**`Put(path, data)`** — writes `data` at the given object key. For local drivers, `path` is a relative path under the configured root directory; parent directories are created automatically. For S3, `path` is the object key within the bucket. The S3 driver resolves and sets `Content-Type` automatically — you do not pass it.

**`Get(path)`** — reads and returns the bytes at the given key. Used rarely in application code — mostly for migrations or tooling. Normal file access goes through URLs, not `Get`.

**`Delete(path)`** — removes the object. For S3, a missing key returns an SDK error. For local, the underlying `os.Remove` error is returned as-is; if you want to treat a missing file as a success, check for `errors.Is(err, os.ErrNotExist)` in the caller.

**`URL(path)`** — returns the direct, permanent URL for an object. **Only meaningful on public drivers.** On private drivers, this always returns an empty string — there is intentionally no permanent URL for a private object. Calling `URL` on a private driver and getting an empty string is not a bug; it is the expected behavior.

**`SignedURL(path, ttl)`** — returns a time-limited URL that grants temporary read access to an object. **Only meaningful on private drivers.** On public drivers, this returns an error. After the URL expires, it stops working and the caller must request a fresh one.

**`IsPublic()`** — the single flag that determines which URL method applies. `true` means call `URL`. `false` means call `SignedURL`. It is set permanently at initialization time — there is no runtime toggle.

**`Type()`** — returns `"local"` or `"s3"`. Identifies which backend the driver is backed by.

Two driver type constants are defined alongside the interface:

```go
const (
    StorageDriverTypeLocal StorageDriverType = "local"
    StorageDriverTypeS3    StorageDriverType = "s3"
)
```

---

## Public vs private

Every driver is either public or private. This is the most important concept in the package.

**Public driver** — objects are directly accessible to anyone with the URL. `IsPublic()` returns `true`. `URL(path)` returns a permanent, direct link. `SignedURL(...)` returns an error because signing a public object is nonsensical.

**Private driver** — objects are not directly accessible. `IsPublic()` returns `false`. `URL(path)` returns an empty string — there is intentionally no permanent URL. `SignedURL(path, ttl)` returns a temporary URL that expires after `ttl`. Once expired, the URL returns a 403 or equivalent; the caller must generate a new one.

You set this at initialization time by which driver you use — `LocalPublic` vs `LocalPrivate`, or which bucket list an S3 bucket is in. There is no way to switch a driver from public to private at runtime.

---

## The local disk driver

Implemented in `backend/storage/drivers/local.go` as `*drivers.LocalStorageDriver`.

Stores objects as regular files on the server's local filesystem under a configured root directory. The local driver exists in two separate instances: **public** and **private**. They are initialized separately, use different root directories, and build URLs under different path prefixes. They are not a single driver with a mode switch.

Both local drivers are **always initialized** by `InitDrivers()`, regardless of whether S3 is configured. If either one fails, the entire app refuses to start.

### Public local driver

Files live under `STORAGE_LOCAL_PUBLIC_ROOT_DIR`.

`URL(path)` returns a direct link. The storage package does **not** register an HTTP file server — that is your app's job. If nothing in your router serves `STORAGE_LOCAL_PUBLIC_URL`, the URL is a string that 404s.

`URL(path)` is built as:

```
APP_URL + STORAGE_LOCAL_PUBLIC_URL + "/" + path
```

For example, with `APP_URL=http://localhost:8003` and `STORAGE_LOCAL_PUBLIC_URL=/storage/public`:

| | |
|---|---|
| Object key | `uploads/a3/f1/user-42/550e8400.png` |
| Direct URL | `http://localhost:8003/storage/public/uploads/a3/f1/user-42/550e8400.png` |

`SignedURL(...)` returns an error on the public local driver.

### Private local driver

Files live under `STORAGE_LOCAL_PRIVATE_ROOT_DIR`. There is no static file server for private files — the storage package only stores and signs. **You are responsible for writing the HTTP handler that actually serves the file to the user.**

That handler needs to:
1. Verify the signed URL is valid (unexpired, correct HMAC, correct object key).
2. Enforce whatever access control your app requires — check the user is authenticated, check they are allowed to access this specific file.
3. Read the file from disk and stream it to the response.

Step 1 is `VerifySignedURLQuery` on the **concrete** `*drivers.LocalStorageDriver` — it is **not** on the `StorageDriver` interface. If you have `sd.LocalPrivate` typed as `StorageDriver`, type-assert it (or keep the factory return value as `*LocalStorageDriver`). Steps 2 and 3 are yours to write.

`URL(path)` returns an empty string on the private local driver.

`SignedURL(path, ttl)` generates a URL of this form:

```
http://localhost:8003/storage/private/?path=uploads/a3/f1/user-42/550e8400.png&exp=1751234567&sig=<hmac>
```

| Query param | What it is |
|---|---|
| `path` | The object key, URL-encoded |
| `exp` | Unix timestamp — the moment the URL expires |
| `sig` | HMAC-SHA256 of `path:exp`, keyed with `STORAGE_LOCAL_PRIVATE_SIGNING_KEY`, URL-safe base64 encoded |

When your handler receives the request, call `local.VerifySignedURLQuery(r.URL.Query())` on that `*LocalStorageDriver`. It checks that the current time is before `exp`, recomputes the HMAC, and compares it to `sig` using a constant-time comparison. If any check fails — wrong key, expired timestamp, tampered path — it returns an error and you should respond with 403. See [HMAC signing internals](./advanced#hmac-signing-internals) for the implementation details.

#### Serving a private file

This is the **download** route — `Put` already ran when you stored the file. The handler verifies the signed URL, runs your access check, reads the file from disk with `Get`, then writes it to the response.

`VerifySignedURLQuery` lives on the **concrete** `*drivers.LocalStorageDriver`, not on the `StorageDriver` interface. That is why `main.go` type-asserts `sd.LocalPrivate` before passing it into the handler.

```go
// handlers/private_download.go

func PrivateDownloadHandler(local *drivers.LocalStorageDriver) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Only GET and HEAD — everything else is rejected up front.
        if r.Method != http.MethodGet && r.Method != http.MethodHead {
            http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
            return
        }

        // Step 1 — verify the signed URL (expiry + HMAC). Rejects tampered or expired links.
        if err := local.VerifySignedURLQuery(r.URL.Query()); err != nil {
            http.Error(w, err.Error(), http.StatusForbidden)
            return
        }

        key := r.URL.Query().Get("path")
        if key == "" {
            http.Error(w, "missing path", http.StatusBadRequest)
            return
        }

        // Step 2 — ACL: check the caller is allowed to read this specific file.
        // The signature only proves the URL was issued by this server — it does not
        // check who is asking. Enforce your own access rules here before reading disk.
        //
        //   if !canAccess(r, key) {
        //       http.Error(w, "forbidden", http.StatusForbidden)
        //       return
        //   }

        // Step 3 — serve the file.
        ct := mime.TypeByExtension(filepath.Ext(key))
        if ct == "" {
            ct = "application/octet-stream"
        }
        w.Header().Set("Content-Type", ct)

        data, err := local.Get(key)
        if err != nil {
            http.NotFound(w, r)
            return
        }
        w.Header().Set("Content-Length", strconv.Itoa(len(data)))
        if r.Method == http.MethodHead {
            w.WriteHeader(http.StatusOK)
            return
        }
        _, _ = w.Write(data)
    }
}
```

In `main.go`, after `InitDrivers()`, assert the concrete type and register the route on the same URL prefix that `SignedURL` embeds in every link:

```go
// main.go

// sd.LocalPrivate is typed as StorageDriver — assert to access VerifySignedURLQuery.
local := sd.LocalPrivate.(*drivers.LocalStorageDriver)

// Register the download handler under the same prefix SignedURL uses.
http.HandleFunc(local.URLSuffix+"/", PrivateDownloadHandler(local))
```

---

## The S3 driver

Implemented in `backend/storage/drivers/s3.go` as `*drivers.S3Storage`.

Uses `aws-sdk-go-v2` with static credentials and path-style URL addressing. Path-style is required by S3-compatible object storage providers (such as Hetzner Object Storage) that don't support virtual-hosted bucket names. The SDK is configured with `UsePathStyle = true` so bucket names appear in the URL path (`endpoint/bucket/key`) rather than in the hostname.

**One driver instance is created per bucket.** If you have a public bucket and a private bucket, you get two separate `*S3Storage` instances. They share the same credentials and endpoint but each is bound to its own bucket and its own public/private mode.

### Public S3 driver

`URL(path)` returns the direct URL for the object. The format depends on whether a CDN is configured:

- With `STORAGE_S3_PUBLIC_BASE_URL` (CDN): `https://cdn.example.com/uploads/a3/f1/user-42/550e8400.png`
- Without CDN: `https://s3.example.com/my-public-bucket/uploads/a3/f1/user-42/550e8400.png`

`SignedURL(...)` returns an error on the public S3 driver.

The CDN variable (`STORAGE_S3_PUBLIC_BASE_URL`) is optional. When set, it is assumed that the CDN root maps to the public bucket's root — so the object key is appended directly to the CDN base URL with no bucket segment. This assumes a single public bucket. If you have two public buckets, you cannot use a CDN this way.

### Private S3 driver

`URL(path)` returns an empty string.

`SignedURL(path, ttl)` calls the AWS presign API and returns an AWS presigned GET URL. The URL embeds AWS-standard signature parameters (`X-Amz-Signature`, `X-Amz-Expires`, etc.) and is validated entirely by S3 — the backend does not verify it on the way back. After `ttl` has elapsed, S3 rejects the URL automatically.

If `ttl` is zero or negative, the driver defaults it to one minute before signing.

### Content-Type handling

When `Put`-ing an object to S3, the driver resolves the `Content-Type` to store alongside the bytes:

1. It checks the file extension first using Go's `mime.TypeByExtension` — this correctly identifies SVG as `image/svg+xml` and WebP as `image/webp`, which byte-sniffing gets wrong.
2. If the extension is unknown or unmapped, it falls back to `http.DetectContentType`, which sniffs the first 512 bytes.

This matters because S3 stores whatever `Content-Type` you give it. Without an explicit type, S3 defaults to `application/octet-stream` — and browsers respond by prompting a file download instead of rendering the image inline. The driver handles this automatically; you never pass a content type yourself.
