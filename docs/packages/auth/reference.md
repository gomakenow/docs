---
title: Reference — Auth
description: Complete API reference—config, errors, types, and every engine method.
---

# Reference

Complete reference for the `auth` package. For tutorials and usage examples, see [Getting started](./).

---

## Construction

```go
// Manual config
cfg := auth.Config{
    JWTSecret: os.Getenv("JWT_SECRET"),
    Issuer:    os.Getenv("API_URL"),
}

// Or load from AUTH_* environment variables
cfg := auth.LoadEnv()

// Create the engine
engine, err := auth.New[*User](cfg, db)
```

`New` returns `ErrNotConfigured` if `JWTSecret` or `Issuer` is empty. TOTP methods fail later if `AppKey` is missing or invalid.

`LoadEnv()` never fails—it reads `AUTH_*` variables and falls back to defaults for missing values.

---

## Configuration

### auth.Config

| Field | Type | Required | Default |
|---|---|---|---|
| `JWTSecret` | `string` | Yes | |
| `Issuer` | `string` | Yes | |
| `BaseURL` | `string` | No | `Issuer` |
| `ResetPath` | `string` | No | `/reset-password` |
| `VerifyPath` | `string` | No | `/verify-email` |
| `TokenQuery` | `string` | No | `token` |
| `AppKey` | `[]byte` | For TOTP | |
| `AppName` | `string` | No | `App` |
| `SessionTTL` | `time.Duration` | No | `0` (no expiry) |
| `ResetTTL` | `time.Duration` | No | `1h` |
| `VerifyTTL` | `time.Duration` | No | `48h` |
| `StateTTL` | `time.Duration` | No | `10m` |
| `OAuthStateSecret` | `string` | No | `JWTSecret` |
| `CredentialTTL` | `map[string]time.Duration` | No | `{}` |
| `Now` | `func() time.Time` | No | `time.Now` |

**JWTSecret**: Signs session tokens. Treat like a password.

**Issuer**: The `iss` claim in every JWT. Usually your API origin.

**BaseURL**: Origin for building reset/verify links. Falls back to `Issuer` if empty. Set this to your frontend URL if it differs from the API.

**AppKey**: 32 bytes for encrypting TOTP secrets. Required for 2FA. Generate with:

```bash
openssl rand -base64 32
```

Store as `AUTH_APP_KEY=base64:...` or raw base64. Decode with `auth.DecodeAppKey(string)`.

**SessionTTL**: Token expiry. `0` = no `exp` claim (recommended for most apps).

**CredentialTTL**: Custom purpose lifetimes. Example:

```go
cfg.CredentialTTL = map[string]time.Duration{
    "invite": 72 * time.Hour,
}
```

### Environment variables

`auth.LoadEnv()` reads these:

| Variable | Maps to |
|---|---|
| `AUTH_JWT_SECRET` | `JWTSecret` |
| `AUTH_ISSUER` | `Issuer` |
| `AUTH_BASE_URL` | `BaseURL` |
| `AUTH_RESET_PATH` | `ResetPath` |
| `AUTH_VERIFY_PATH` | `VerifyPath` |
| `AUTH_TOKEN_QUERY` | `TokenQuery` |
| `AUTH_APP_KEY` | `AppKey` (decoded) |
| `AUTH_APP_NAME` | `AppName` |
| `AUTH_SESSION_TTL` | `SessionTTL` |
| `AUTH_RESET_TTL` | `ResetTTL` |
| `AUTH_VERIFY_TTL` | `VerifyTTL` |
| `AUTH_STATE_TTL` | `StateTTL` |

Duration format: `1h`, `30m`, `48h`, etc. (`time.ParseDuration`).

---

## Errors

All errors are sentinel values. Use `errors.Is(err, auth.ErrXxx)` for comparison.

### Login errors

| Error | When | What to return |
|---|---|---|
| `ErrInvalidCredentials` | Email not found or wrong password | 401 "Invalid email or password" |
| `ErrTwoFactorRequired` | Password correct, 2FA enabled, no code sent | 401 "Two-factor code required" |
| `ErrInvalidOTP` | TOTP or recovery code wrong | 401 "Invalid two-factor code" |

### Token errors

| Error | When |
|---|---|
| `ErrInvalidToken` | Bad signature, malformed JWT, wrong issuer |
| `ErrExpiredToken` | JWT `exp` is in the past |
| `ErrWrongPurpose` | Session API called with reset/verify token, or vice versa |
| `ErrMissingToken` | No `Authorization` header (middleware only) |

### Configuration errors

| Error | When |
|---|---|
| `ErrNotConfigured` | Empty `JWTSecret` or `Issuer` when calling `New` |
| `ErrAppKeyInvalid` | `AppKey` is not exactly 32 bytes |
| `ErrNilDB` | Middleware/`Attempt` called but `db` is `nil` |

### Credential errors

| Error | When |
|---|---|
| `ErrInvalidResetToken` | Digest missing (never issued) or already consumed |
| `ErrInvalidResetDigest` | Stored digest is not 64 hex characters |
| `ErrUnknownPurpose` | `IssueCredential` called with unknown purpose |
| `ErrEmptySubject` | Empty string passed to `IssueSession`/`IssueCredential` |
| `ErrEmptyPurpose` | Empty string passed to `IssueCredential` |

### OAuth errors

| Error | When |
|---|---|
| `ErrInvalidOAuthState` | Bad HMAC, expired, or audience mismatch |

### Other errors

| Error | When |
|---|---|
| `ErrIdentityNotFound` | `Lookuper` returned `gorm.ErrRecordNotFound` |
| `ErrInvalidSessionTTL` | `IssueSessionWithExpiry` called with `ttl <= 0` |

---

## Types

### Identity[T]

Returned by your `LookupByEmail` and `LookupBySubject` methods.

```go
type Identity[T any] struct {
    User               T          // Your user model
    Subject            string     // JWT sub claim
    PasswordHash       string     // bcrypt hash
    TwoFactorSecret    *string    // Encrypted TOTP secret (nil = 2FA off)
    RecoveryCodes      []string   // Hashed recovery codes
    SessionsValidAfter *time.Time // Cutoff for old tokens
}
```

**Method:** `HasTwoFactor() bool` — true if `TwoFactorSecret` is non-empty.

### AttemptResult[T]

Returned by `Attempt`.

```go
type AttemptResult[T any] struct {
    Token             string      // Session JWT
    Identity          Identity[T] // Logged-in identity
    UsedRecovery      bool        // True if recovery code used
    RemainingRecovery []string    // Persist this if UsedRecovery
}
```

### Claims

Decoded JWT.

```go
type Claims struct {
    Issuer    string `json:"iss"`
    IssuedAt  int64  `json:"iat"`
    Subject   string `json:"sub"`
    ExpiresAt int64  `json:"exp,omitempty"`
    Purpose   string `json:"purpose,omitempty"` // Empty for sessions
    JWTID     string `json:"jti,omitempty"`
}
```

### CredentialLink

Returned by `GenerateReset` and `GenerateVerification`.

```go
type CredentialLink struct {
    Token  string // Raw JWT (put in email)
    Link   string // Complete URL
    Digest string // SHA-256 hex (stored in password_reset_tokens)
}
```

### RotatedSession

Returned by `RotateSession`.

```go
type RotatedSession struct {
    Cutoff time.Time // Persist as sessions_valid_after
    Token  string    // New JWT
}
```

### TOTPKey

Returned by `GenerateTOTP`.

```go
type TOTPKey struct {
    Secret string // Plaintext secret (base32)
    URL    string // otpauth:// URI
}
```

### TOTPEnrollment

Returned by `BeginTOTP`.

```go
type TOTPEnrollment struct {
    Secret   string // Plaintext secret
    URL      string // otpauth:// URI
    QRPNG    []byte // QR code as PNG
    QRBase64 string // Base64-encoded PNG
}
```

---

## Engine methods

All methods are on `*auth.Engine[T]` where `T` is your user type.

### Sessions

```go
IssueSession(subject string) (string, error)
```

Mints a session JWT. Subject is usually the user id (`fmt.Sprint(user.ID)`).

```go
IssueSessionWithExpiry(subject string, ttl time.Duration) (string, error)
```

Same but with explicit expiry, ignoring `SessionTTL`.

```go
RotateSession(subject string) (RotatedSession, error)
```

Mints a new token and returns a cutoff to store on `sessions_valid_after`.

```go
ValidateToken(raw string) (Claims, error)
```

Parses any kit JWT (session or credential). Does not look up user.

```go
ValidateSession(raw string) (Claims, error)
```

Parses a session JWT. Rejects tokens with a `purpose` claim.

### Login

```go
Attempt(email, password, totp string) (AttemptResult[T], error)
```

Full password login with optional 2FA. Returns session token and identity.

### Passwords

Package functions (not on engine):

```go
auth.Hash(plain string) (string, error)          // bcrypt hash
auth.Check(plain, hash string) bool              // verify password
```

### Credentials (email links)

```go
IssueCredential(purpose, subject string) (string, error)
```

Mints a purpose-scoped JWT. Purpose is first argument.

```go
ValidateCredential(raw, purpose string) (Claims, error)
```

Validates a credential JWT and checks purpose matches.

```go
GenerateReset(db *gorm.DB, subject string) (CredentialLink, error)
```

Issues reset token, stores digest in `password_reset_tokens`, returns link.

```go
GenerateVerification(subject string) (CredentialLink, error)
```

Issues verify token and link. Not stored.

```go
ConsumeResetToken(db *gorm.DB, raw string) (Claims, error)
```

Validates reset token and deletes digest. One-time use.

Related package functions:

```go
auth.StoreReset(db *gorm.DB, subject, rawToken string) error
auth.StoreResetLink(db *gorm.DB, subject, fullURL string) error
auth.TokenDigest(rawToken string) string
auth.IsTokenDigest(value string) bool
```

### TOTP

```go
GenerateTOTP(account string) (*TOTPKey, error)
```

Creates TOTP secret and otpauth URL.

```go
BeginTOTP(account string) (*TOTPEnrollment, error)
```

Same as `GenerateTOTP` but includes QR code PNG.

```go
ConfirmTOTP(code, plainSecret string) (string, error)
```

Validates code and returns encrypted secret to persist.

```go
ValidateTOTP(code, encryptedSecret string) (bool, error)
```

Validates code against encrypted secret stored in DB.

```go
ValidateTOTPPlain(code, secret string) (bool, error)
```

Validates code against plaintext secret (tests or before encryption).

### Encryption

```go
Encrypt(plainText string) (string, error)
Decrypt(cryptoText string) (string, error)
```

AES-CBC encrypt/decrypt with `AppKey`. For secrets, not passwords.

### Recovery codes

Package function:

```go
auth.GenerateRecoveryCodes(n int) (plain, hashed []string, err error)
```

Generates `n` codes (default 8 if `n <= 0`). `plain` is shown to user. `hashed` is stored.

```go
auth.ConsumeRecoveryCode(plain string, hashed []string) (remaining []string, ok bool, err error)
```

Removes matching code from list. Used internally by `Attempt`.

### OAuth state

```go
SignOAuthState(audience string) (string, error)
```

Signs CSRF state for OAuth redirect. Audience is provider name (`"google"`, `"github"`).

```go
ValidateOAuthState(state, audience string) error
```

Validates state on callback. Checks HMAC, expiry, audience.

```go
SignOAuthStateAt(audience string, issuedAt time.Time, nonce string) (string, error)
ValidateOAuthStateAt(state, audience string, now time.Time) error
```

Same as above but with injected time (for tests).

### Middleware

```go
JWTMiddleware() func(http.Handler) http.Handler
```

Optional authentication. Guests allowed; invalid tokens continue as guest.

```go
AuthMiddleware() func(http.Handler) http.Handler
```

Required authentication. Missing/invalid token → 401.

### Context helpers

Package functions:

```go
auth.UserFromContext[T](ctx context.Context) (T, bool)
auth.IdentityFromContext[T](ctx context.Context) (Identity[T], bool)
auth.ClaimsFromContext(ctx context.Context) (Claims, bool)

auth.ContextWithIdentity[T](ctx context.Context, id Identity[T]) context.Context
auth.ContextWithClaims(ctx context.Context, claims Claims) context.Context
```

---

## Lookuper interface

Your user type must implement:

```go
type Lookuper[T any] interface {
    LookupByEmail(db *gorm.DB, email string) (*Identity[T], error)
    LookupBySubject(db *gorm.DB, subject string) (*Identity[T], error)
}
```

**Rules:**

1. Return `gorm.ErrRecordNotFound` for missing users (do not wrap).
2. Return `nil` identity or empty `Subject` → treated as not found.
3. `Subject` must match what you pass to `IssueSession`.
4. `TwoFactorSecret` is **encrypted**, not plaintext.
5. Engine lowercases email before calling `LookupByEmail`.

Typically implement on `*User`:

```go
func (u *User) LookupByEmail(db *gorm.DB, email string) (*auth.Identity[*User], error) {
    var user User
    err := db.Where("email = ?", email).First(&user).Error
    if err != nil {
        return nil, err
    }
    return &auth.Identity[*User]{
        User:    &user,
        Subject: fmt.Sprint(user.ID),
        // ... other fields
    }, nil
}
```

Then construct engine as `auth.New[*User](cfg, db)`.

---

## Database table

The package creates one table:

**password_reset_tokens**

| Column | Type | Description |
|---|---|---|
| `email` | `varchar` | Subject key (usually email, lowercased) |
| `token` | `varchar` | SHA-256 hex digest (not the JWT) |
| `created_at` | `timestamptz` | When digest was stored |

Unique on `email`. New reset replaces old one.

---

## Built-in purposes

```go
auth.PurposePasswordReset      // "password_reset"
auth.PurposeEmailVerification  // "email_verification"
```

Use these with `IssueCredential` and `ValidateCredential`.

---

## Makefile targets

From `backend/auth/`:

```bash
make test-auth                          # Run all package tests (SQLite)
make test-auth TestAttemptSuccess       # Run one test
make auth-migrate-new MIGRATION_NAME=foo  # Create new migration
make migrate-publish                    # Copy SQL to db/migrations
make migrate-publish TARGET_DIR=/path   # Custom target
```

---

## Package functions vs engine methods

Some functions are on the engine, some are package-level:

**Engine methods** (need `engine`):
- `IssueSession`, `Attempt`, `ValidateSession`
- `GenerateReset`, `BeginTOTP`, `ValidateTOTP`
- `JWTMiddleware`, `AuthMiddleware`

**Package functions** (call `auth.Xxx`):
- `Hash`, `Check` (passwords)
- `StoreReset`, `TokenDigest` (reset helpers)
- `GenerateRecoveryCodes`, `ConsumeRecoveryCode`
- `UserFromContext`, `IdentityFromContext`
- `LoadEnv`, `DecodeAppKey`

Engine methods need config or database. Package functions are stateless helpers.
