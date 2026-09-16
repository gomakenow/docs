---
title: Auth
description: JWT sessions, password login, email links, TOTP, and request middleware. You own the users table and the HTTP routes.
---

# Auth

<Badge type="tip" text="Requires migration" />

Building authentication from scratch means implementing the same patterns every time: bcrypt for passwords, HMAC-signed JWTs for sessions, purpose-scoped tokens for password resets, and TOTP for two-factor. These primitives are well-understood, but getting the details right—token expiry, one-time link consumption, recovery codes—takes time and creates room for mistakes.

The `auth` package implements these primitives so you don't have to. It provides session management, password hashing, reset/verify tokens, TOTP enrollment, and HTTP middleware. You keep full control: the package never touches your `users` table, doesn't register routes, doesn't send email, and doesn't choose your OAuth providers. It's a kit for the token and credential layer that sits between your HTTP handlers and your database.

Import the root package:

```go
import "yourmodule/backend/auth"
```

Construct an `Engine` once at boot and pass it into handlers. Subfolders (`configs/`, `errors/`, `models/`, `services/`) are internals—you don't import them directly.

::: info What auth does not do
The package does not own a users table, does not register HTTP routes, does not send email, does not talk to Google or GitHub, and does not decide roles or permissions. Those stay in your application. The package signs tokens, checks passwords, encrypts TOTP secrets, and stores one-time reset digests in `password_reset_tokens`.
:::

---

## What you get

The package handles the token layer. Your application handles the business rules.

| Package provides | You provide |
|---|---|
| Session JWTs (`iss`, `sub`, `iat`, optional `exp`) | `users` table and schema |
| Password login via `Attempt(email, password, totp)` | `LookupByEmail` / `LookupBySubject` on your user model |
| bcrypt `Hash` / `Check` | HTTP handlers (`POST /login`, `POST /register`, …) |
| Purpose-scoped tokens for reset / verify | Email HTML and sending logic |
| Signed OAuth CSRF state | Google / GitHub OAuth integration |
| TOTP generate / confirm / validate | Roles, bans, permissions |
| AES-CBC encrypt / decrypt for secrets | |
| HTTP middleware that loads the user onto `context` | |

One table ships with the package: `password_reset_tokens`. This stores SHA-256 digests of reset tokens so each link can only be used once. Everything else—passwords, TOTP secrets, recovery codes, session cutoffs—lives on your user row.

---

## How it works

```
  Browser
     │
     ▼
  Your HTTP handlers
     │  ← You write routes, parse JSON, queue email
     ▼
  ┌──────────────────────┐
  │   auth.Engine[T]     │  ← Attempt / IssueSession / GenerateReset
  │                      │     BeginTOTP / ConfirmTOTP / middleware
  └──────────┬───────────┘
             │
     ┌───────┴────────┐
     ▼                ▼
  users table    password_reset_tokens
  (yours)        (package table)
```

The engine is generic over your user type `T`. You implement two lookup methods (`LookupByEmail`, `LookupBySubject`), and the package calls them during login and on every authenticated request. The package never queries your table directly.

---

## Session subjects explained

Every session JWT contains a `sub` claim. This is a string that uniquely identifies the user. The package does not decide what goes in `sub`—you do.

| Identifier | Where | When used |
|---|---|---|
| Email | User row, passed to login | `Attempt` looks up by email, then checks password |
| Subject | JWT `sub`, returned by your `identity()` helper | Middleware calls `LookupBySubject` on every request |

Most applications use the numeric user id as the subject: `fmt.Sprint(user.ID)` or a UUID string. Using the email as the subject works, but renaming an email then invalidates every session. A stable id is safer.

---

## Step 1 — Publish the migration

The package ships SQL for `password_reset_tokens`. Publish it into your `db/migrations/` directory:

```bash
make -C backend/auth migrate-publish
# then run your usual migrate-up
```

You still create your own `users` table. A minimal schema for password + 2FA support:

| Column | Type | Why |
|---|---|---|
| `id` | `bigint` or `uuid` | Stable subject for JWT `sub` |
| `email` | `varchar` | Login identifier |
| `password` | `varchar` | bcrypt hash |
| `email_verified_at` | `timestamptz` | Optional; the package does not enforce this |
| `two_factor_secret` | `text` | Encrypted TOTP secret, or `NULL` |
| `two_factor_recovery_codes` | `jsonb` or `text` | Hashed recovery codes |
| `sessions_valid_after` | `timestamptz` | Optional cutoff; tokens issued before this fail |

Column names are yours. The package never touches this table—it only calls the lookup methods you write.

---

## Step 2 — Build the configuration

The engine needs a JWT secret and an issuer. You can build the config from your existing environment loader or use `auth.LoadEnv()` for convenience.

**Option A: Build config from your app's env (recommended)**

Most applications already have an environment loader. Read your config and construct `auth.Config`:

```go
cfg := auth.Config{
    JWTSecret: os.Getenv("JWT_SECRET"),
    Issuer:    os.Getenv("API_BASE_URL"),
    AppKey:    decodeAppKey(os.Getenv("APP_KEY")), // 32 bytes for TOTP
    AppName:   "YourApp",
}
```

**Option B: Use LoadEnv for AUTH_\* variables**

If you prefer dedicated `AUTH_*` environment variables:

```go
cfg := auth.LoadEnv()
```

This reads `AUTH_JWT_SECRET`, `AUTH_ISSUER`, `AUTH_APP_KEY`, etc., and applies defaults (1-hour reset TTL, 48-hour verify TTL).

**Required fields:**
- `JWTSecret` — Signs session tokens (keep this secret)
- `Issuer` — The `iss` claim, typically your API origin

**Optional fields:**
- `AppKey` — 32 bytes for encrypting TOTP secrets (required for two-factor)
- `BaseURL` — Origin for reset/verify links (defaults to `Issuer`)
- `SessionTTL`, `ResetTTL`, `VerifyTTL` — Token lifetimes

See [Reference](./reference) for the complete config struct and all environment variable names.

---

## Step 3 — Implement Lookuper on your user model

The engine needs two methods to find users. Add them to your user type:

```go
package models

import (
    "fmt"
    "time"
    "yourmodule/backend/auth"
    "gorm.io/gorm"
)

type User struct {
    ID                   int64      `gorm:"primaryKey"`
    Email                string     `gorm:"uniqueIndex"`
    Password             string
    TwoFactorSecret      *string
    RecoveryCodes        []string   `gorm:"serializer:json"`
    SessionsValidAfter   *time.Time
}

func (u *User) LookupByEmail(db *gorm.DB, email string) (*auth.Identity[*User], error) {
    var user User
    if err := db.Where("email = ?", email).First(&user).Error; err != nil {
        return nil, err // gorm.ErrRecordNotFound signals "no such user"
    }
    return buildIdentity(&user), nil
}

func (u *User) LookupBySubject(db *gorm.DB, subject string) (*auth.Identity[*User], error) {
    var user User
    if err := db.Where("id = ?", subject).First(&user).Error; err != nil {
        return nil, err
    }
    return buildIdentity(&user), nil
}

func buildIdentity(user *User) *auth.Identity[*User] {
    return &auth.Identity[*User]{
        User:               user,
        Subject:            fmt.Sprint(user.ID),
        PasswordHash:       user.Password,
        TwoFactorSecret:    user.TwoFactorSecret,
        RecoveryCodes:      user.RecoveryCodes,
        SessionsValidAfter: user.SessionsValidAfter,
    }
}
```

**Key rules:**

1. **Missing user → `gorm.ErrRecordNotFound`**. Do not wrap the error. Any other error is treated as a database failure. At login, a missing user becomes `auth.ErrInvalidCredentials` so attackers can't probe emails.
2. **`Subject` must be stable**. If you return `"42"`, middleware will call `LookupBySubject(db, "42")` on later requests. Match the JWT.
3. **`TwoFactorSecret` is encrypted**. Store the output of `engine.Encrypt()`, not the plaintext TOTP secret.

---

## Step 4 — Construct the engine

Create the engine in your initialization code:

```go
cfg := auth.Config{
    JWTSecret: os.Getenv("JWT_SECRET"),
    Issuer:    os.Getenv("API_BASE_URL"),
    AppKey:    appKey, // from your env loader
    AppName:   "YourApp",
}

engine, err := auth.New[*User](cfg, db)
if err != nil {
    log.Fatalf("auth engine: %v", err)
}
```

`db` is your GORM connection. The engine uses it for `LookupByEmail` / `LookupBySubject` during login and on authenticated requests. Pass `nil` if you only mint tokens without lookups (rare).

Create one engine per process and pass it into handlers.

---

## Step 5 — Hash passwords on registration

When a user registers, hash their password with bcrypt before saving it to the database. Never store plaintext passwords.

```go
hash, err := auth.Hash(plainPassword)
if err != nil {
    // bcrypt failure is a server error, not a user error
    return err
}
```

`auth.Hash` runs bcrypt at the default cost and returns a hash string like `$2a$10$N9qo8uLOickgx2ZMRZoMy...`. This is what you store in `users.password`.

Store the hash on your user row:

```go
user := &models.User{
    Email:    email,
    Password: hash, // Store the hash, not plaintext
}
db.Create(user)
```

After creating the user, issue a session token so they're logged in immediately:

```go
token, err := engine.IssueSession(fmt.Sprint(user.ID))
if err != nil {
    return err
}
// Return token to client
```

`IssueSession(subject)` mints a JWT with `sub = "42"` (or whatever the user id is). The subject must match what your `LookupBySubject` method expects.

The package also exports `auth.Check(plain, hash) bool` for manually checking passwords, but you rarely call it—`Attempt` does this during login.

<details>
<summary><strong>Full registration handler example</strong></summary>

```go
func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Email    string `json:"email"`
        Password string `json:"password"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    // Hash the password
    hash, err := auth.Hash(req.Password)
    if err != nil {
        log.Printf("hash failed: %v", err)
        http.Error(w, "registration failed", http.StatusInternalServerError)
        return
    }

    // Create the user
    user := &models.User{
        Email:    req.Email,
        Password: hash,
    }
    if err := db.Create(user).Error; err != nil {
        http.Error(w, "email already exists", http.StatusConflict)
        return
    }

    // Issue session token
    token, err := h.authEngine.IssueSession(fmt.Sprint(user.ID))
    if err != nil {
        http.Error(w, "failed to create session", http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(map[string]any{
        "token": token,
        "user":  user,
    })
}
```

</details>

---

## Step 6 — Implement login with Attempt

Login checks the password, handles two-factor if enabled, and returns a session JWT.

Call `engine.Attempt` with email, password, and an optional TOTP code:

```go
result, err := engine.Attempt(email, password, totpCode)
if err != nil {
    // Handle errors (see below)
    return
}
// result.Token is the session JWT
```

**What `Attempt` does internally:**

1. Calls `user.LookupByEmail(db, email)` to find the user. Missing user → `ErrInvalidCredentials`.
2. Checks the password with bcrypt. Wrong password → `ErrInvalidCredentials`.
3. If `Identity.TwoFactorSecret` is set but `totpCode` is empty → `ErrTwoFactorRequired`.
4. If `totpCode` is provided, validates it against the TOTP secret or recovery codes. Wrong code → `ErrInvalidOTP`.
5. If a recovery code matched, sets `UsedRecovery = true` and returns the remaining codes.
6. Issues a session JWT with `sub = Identity.Subject`.

Map errors to HTTP responses:

```go
switch {
case errors.Is(err, auth.ErrInvalidCredentials):
    // Wrong email or wrong password (same message to avoid leaking info)
    http.Error(w, "invalid email or password", http.StatusUnauthorized)
case errors.Is(err, auth.ErrTwoFactorRequired):
    // Password correct, but 2FA enabled and no code sent
    http.Error(w, "two-factor code required", http.StatusUnauthorized)
case errors.Is(err, auth.ErrInvalidOTP):
    // Password correct, but TOTP code was wrong
    http.Error(w, "invalid two-factor code", http.StatusUnauthorized)
default:
    // Database error, misconfigured engine, etc.
    http.Error(w, "login failed", http.StatusInternalServerError)
}
```

If the user logged in with a recovery code, persist the remaining codes:

```go
if result.UsedRecovery {
    // Update the user's recovery_codes with result.RemainingRecovery
    // so they can't reuse the same code
    db.Model(&models.User{}).
        Where("id = ?", result.Identity.User.ID).
        Update("recovery_codes", result.RemainingRecovery)
}
```

Return the token to the client:

```go
json.NewEncoder(w).Encode(map[string]any{
    "token": result.Token,         // Session JWT
    "user":  result.Identity.User, // Full *User struct
})
```

The client stores the token and sends `Authorization: Bearer <token>` on every authenticated request.

<details>
<summary><strong>Full login handler example</strong></summary>

```go
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Email    string `json:"email"`
        Password string `json:"password"`
        Totp     string `json:"totp"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    result, err := h.authEngine.Attempt(req.Email, req.Password, req.Totp)
    if err != nil {
        switch {
        case errors.Is(err, auth.ErrInvalidCredentials):
            http.Error(w, "invalid email or password", http.StatusUnauthorized)
        case errors.Is(err, auth.ErrTwoFactorRequired):
            http.Error(w, "two-factor code required", http.StatusUnauthorized)
        case errors.Is(err, auth.ErrInvalidOTP):
            http.Error(w, "invalid two-factor code", http.StatusUnauthorized)
        default:
            log.Printf("login failed: %v", err)
            http.Error(w, "login failed", http.StatusInternalServerError)
        }
        return
    }

    if result.UsedRecovery {
        err := db.Model(&models.User{}).
            Where("id = ?", result.Identity.User.ID).
            Update("recovery_codes", result.RemainingRecovery).Error
        if err != nil {
            log.Printf("failed to update recovery codes: %v", err)
            http.Error(w, "login succeeded but recovery code update failed", http.StatusInternalServerError)
            return
        }
    }

    json.NewEncoder(w).Encode(map[string]any{
        "token": result.Token,
        "user":  result.Identity.User,
    })
}
```

</details>

---

## Step 7 — Read authenticated users from context

After login returns a JWT, the client sends it on later requests. Your middleware validates the token and loads the user onto the request context. Read it in your handlers:

```go
user, ok := auth.UserFromContext[*models.User](r.Context())
if !ok {
    // No user on context (not logged in)
    http.Error(w, "unauthorized", http.StatusUnauthorized)
    return
}

fmt.Printf("User %s is logged in\n", user.Email)
```

Always check `ok` on routes where authentication is optional. On protected routes where middleware already blocked guests, `ok` is always `true`.

You can also read the JWT claims or full identity:

```go
claims, ok := auth.ClaimsFromContext(r.Context())
// claims.Subject, claims.IssuedAt, claims.ExpiresAt

identity, ok := auth.IdentityFromContext[*models.User](r.Context())
// identity.User, identity.SessionsValidAfter
```

### Quick start: Use the package middleware

The auth package provides ready-to-use middleware:

```go
// Optional auth: guests allowed
r.Use(engine.JWTMiddleware())
r.Get("/products", listProducts)

// Required auth: 401 if not logged in
r.Group(func(r chi.Router) {
    r.Use(engine.AuthMiddleware())
    r.Get("/me", getProfile)
})
```

Both read `Authorization: Bearer <token>`, validate the JWT, and load the user onto context. See [Middleware](./middleware) for details on how they work, handling cookies, and writing custom middleware.

---

## What's next

You now have working registration, login, and authenticated request handling. For more advanced features and details:

| Topic | Link |
|---|---|
| Package middleware vs custom, handling cookies | [Middleware](./middleware) |
| How JWTs work, logout, session rotation | [Sessions](./sessions) |
| Password-reset and email-verification links | [Email links](./credentials) |
| TOTP enrollment, recovery codes, OAuth CSRF state | [2FA and OAuth](./totp) |
| Full config, errors, and method reference | [Reference](./reference) |
| Testing with the engine | [Testing](./testing) |
