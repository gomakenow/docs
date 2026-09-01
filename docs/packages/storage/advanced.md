---
title: Advanced — Storage
description: Building object keys, shard directories, path traversal protection, HMAC signing internals, and adding a new driver.
---

# Advanced

The [Getting started](/packages/storage/) page covers the common case. This page goes further: what happens inside the helpers, how the path safety and signing work, and how to extend the package with a new backend.

---

## Building object keys — helpers.BuildPath

You can construct an object key as any string you like — `"avatars/user-42.png"` is perfectly valid. When you want a key that is collision-resistant and distributes files evenly across directories, use `helpers.BuildPath`:

```go
// backend/storage/helpers/path.go
func BuildPath(prefix, shardKey, groupID, originalFilename string) string
```

It produces a key of the form: `<prefix>/<shard>/<groupID>/<uuid><ext>`

| Argument | What it is | Example |
|---|---|---|
| `prefix` | Top-level logical folder | `"uploads"`, `"avatars"` |
| `shardKey` | Any stable string used to spread files across directories | a user ID: `"42"` |
| `groupID` | Second-level grouping under the shard | `"user-42"`, a strategy ID |
| `originalFilename` | The uploaded file's name — only the extension is kept | `"photo.png"` |

```go
key := helpers.BuildPath("uploads", "42", "user-42", "photo.png")
// → "uploads/a3/f1/user-42/550e8400-e29b-41d4-a716-446655440000.png"
```

The base name is replaced with a random UUID so two uploads of `photo.png` never collide. The shard segment (`a3/f1`) is explained below.

---

## Shard directories

`helpers.BuildPath` inserts a two-level shard segment into every object key:

```
uploads/a3/f1/user-42/550e8400-e29b-41d4-a716-446655440000.png
         ^^^^^ shard
```

The shard is derived from `SHA1(shardKey)`. The first four hex characters are split into two two-character groups: `hexStr[0:2] + "/" + hexStr[2:4]`. This produces 256 × 256 = 65 536 possible shard directories.

**Why this exists**

Without sharding, a high-traffic application accumulates hundreds of thousands of files in a single directory. Most filesystems degrade significantly at that scale — directory listings become slow, inode lookup tables swell, and metadata operations start blocking. S3-style list operations become expensive and paginated. The shard spread prevents this by capping each leaf directory at a manageable size, at the cost of slightly deeper key paths.

**Two files with the same `shardKey` land in the same shard directory** — that is fine and expected. The point is not perfect distribution per-entity, it is even distribution across the storage tree overall. The UUID base name ensures no two files with the same key ever collide, regardless of which shard they are in.

**Implementation:**

```go
func shard(key string) string {
    hash := sha1.Sum([]byte(key))
    hexStr := hex.EncodeToString(hash[:])
    return hexStr[0:2] + "/" + hexStr[2:4]  // e.g. "a3/f1"
}
```

---

## Path traversal protection

Both local drivers (`LocalPublic` and `LocalPrivate`) run every object key through `helpers.FullPath(basePath, path)` before any filesystem operation:

```go
// helpers/local_helper.go
func FullPath(basePath, path string) (string, error)
```

It works as follows:

1. Calls `filepath.Clean(path)` to normalize the key (collapse `..`, remove double slashes, etc.)
2. Immediately rejects the result if it starts with `..` — catching the most obvious traversal attempt.
3. Joins the cleaned path to `basePath` with `filepath.Join`.
4. Resolves both `basePath` and the joined result to absolute paths with `filepath.Abs`.
5. Checks that the absolute joined path starts with `basePath + separator`. If it doesn't, the key escapes the root directory and is rejected.

This means all of the following key values are safely rejected before touching disk:

```
../../../etc/passwd
/etc/passwd
uploads/../../secret.txt
```

You do not need to sanitize object keys before passing them to a local driver. The protection is unconditional and happens inside every `Put`, `Get`, and `Delete` call.

---

## HMAC signing internals

Private local download URLs are signed and verified with HMAC-SHA256. The relevant functions are in `helpers/local_helper.go`.

### Signing a URL

`SignPrivateURLToken(key []byte, path string, expUnix int64) string`

Produces the `sig` query parameter:

1. Constructs the message as `path + ":" + strconv.FormatInt(expUnix, 10)` — for example, `uploads/a3/f1/file.png:1751234567`.
2. Computes HMAC-SHA256 of that message using `key` as the HMAC key.
3. Encodes the result as URL-safe base64 (`base64.URLEncoding`).

The private local driver calls this inside `SignedURL(path, ttl)` and embeds the result as the `sig` query parameter.

### Verifying a URL

`VerifyPrivateSignedURL(key []byte, path string, expUnix int64, sig string) error`

Your download handler should call this (or `VerifyPrivateSignedURLQuery`) on every incoming request:

1. Checks that `path` is non-empty and `expUnix` is positive.
2. Checks that `time.Now().Unix() <= expUnix` — rejects expired URLs with a clear error before even looking at the signature.
3. Decodes `sig` from URL-safe base64. Returns an error if decoding fails (malformed or truncated signature).
4. Recomputes the expected HMAC from `path:expUnix` using `key`.
5. Compares the computed HMAC to the decoded `sig` using `hmac.Equal` — a constant-time comparison that prevents timing attacks.

A convenience wrapper `VerifyPrivateSignedURLQuery(v url.Values, key []byte)` extracts `path`, `exp`, and `sig` from the URL query params and calls `VerifyPrivateSignedURL`. The local private driver exposes the same check as `(*LocalStorageDriver).VerifySignedURLQuery` — that is what your handler should call.

---

## Adding a new driver

If you need a third storage backend — Google Cloud Storage, Azure Blob, Backblaze B2 — the extension points are well-defined.

### Step 1 — Implement the interface

Create `backend/storage/drivers/gcs.go`. Define a struct and implement every method of `StorageDriver`. Add a compile-time assertion immediately after the struct:

```go
// backend/storage/drivers/gcs.go

type GCSStorage struct {
    Public  bool
    Bucket  string
    BaseURL string
    // ... GCS client fields
}

// Compile-time check — if GCSStorage is missing any method, the build fails here.
var _ StorageDriver = (*GCSStorage)(nil)

func (s *GCSStorage) Type() StorageDriverType { return StorageDriverTypeGCS }
func (s *GCSStorage) IsPublic() bool          { return s.Public }
func (s *GCSStorage) Put(path string, data []byte) error { ... }
func (s *GCSStorage) Get(path string) ([]byte, error)    { ... }
func (s *GCSStorage) Delete(path string) error           { ... }
func (s *GCSStorage) URL(path string) string             { ... }
func (s *GCSStorage) SignedURL(path string, ttl time.Duration) (string, error) { ... }
```

If `GCSStorage` is missing any method of the interface, the `var _ StorageDriver = (*GCSStorage)(nil)` line fails at compile time with a clear error pointing to this file.

### Step 2 — Add a type constant

Add the new driver type to `backend/storage/drivers/driver.go`:

```go
const (
    StorageDriverTypeLocal StorageDriverType = "local"
    StorageDriverTypeS3    StorageDriverType = "s3"
    StorageDriverTypeGCS   StorageDriverType = "gcs"  // add this
)
```

### Step 3 — Add a factory function

Add a factory to `backend/storage/storage.go`, following the same load-then-validate pattern as `S3Storage`:

```go
func GCSStorage(isPublic bool, bucket string) (*drivers.GCSStorage, error) {
    e := LoadEnv()
    if err := e.ValidateForGCS(); err != nil {
        return nil, err
    }
    return drivers.NewGCSStorageDriver(isPublic, bucket, e.GCSProject, e.GCSCredentials)
}
```

### Step 4 — Add env variables and validation

Add `GCS_*` field constants and a `ValidateForGCS()` method to `backend/storage/config.go`:

```go
type StorageEnv struct {
    // ... existing fields ...
    GCSProject     string
    GCSCredentials string  // e.g. path to service account JSON
}

const (
    // ... existing constants ...
    envSTORAGEGCSProject     = "STORAGE_GCS_PROJECT"
    envSTORAGEGCSCredentials = "STORAGE_GCS_CREDENTIALS"
)

func (e StorageEnv) ValidateForGCS() error {
    if e.GCSProject == "" {
        return fmt.Errorf("storage: %s is required for gcs", envSTORAGEGCSProject)
    }
    if e.GCSCredentials == "" {
        return fmt.Errorf("storage: %s is required for gcs", envSTORAGEGCSCredentials)
    }
    return nil
}
```

Mirror the style of the existing validation methods exactly — include the env var name in the error message so a misconfigured deployment gets an actionable error.

### Step 5 — Wire into InitDrivers

Add a `GCS` field to `storage.Drivers` in `backend/storage/drivers_set.go` and populate it inside `InitDrivers()`:

```go
type Drivers struct {
    LocalPublic  drivers.StorageDriver
    LocalPrivate drivers.StorageDriver
    S3ByBucket   map[string]drivers.StorageDriver
    GCS          drivers.StorageDriver  // add this; nil if not configured
}

func InitDrivers() (Drivers, error) {
    // ... existing init ...

    // Build GCS driver if STORAGE_GCS_PROJECT is set
    if env.GCSProject != "" {
        gcs, err := GCSStorage(true, env.GCSBucket)
        if err != nil {
            return Drivers{}, fmt.Errorf("storage: init GCS: %w", err)
        }
        sd.GCS = gcs
    }

    return sd, nil
}
```

### Step 6 — Update callers that switch on Type()

Anything that branches on `StorageDriverTypeLocal` vs `StorageDriverTypeS3` needs a third case. Search from the storage package and the rest of the app:

```sh
rg "StorageDriverTypeLocal|StorageDriverTypeS3"
```

For each match, add `StorageDriverTypeGCS`. If a switch has no default and you miss a call site, it will compile — and then fail at runtime when a GCS object shows up. Do not skip this step.
