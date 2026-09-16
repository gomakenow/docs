---
title: Sessions — Auth
description: How session JWTs work, token lifetimes, logging out, and session rotation.
---

# Sessions

A session is a signed JWT that proves "this request is from user X." It is not a database row. The package does not store sessions—validity comes from the signature, the issuer, optional expiry, and (if you set it) a cutoff timestamp on the user row.

---

## What's in the JWT

Every session token contains these claims:

| Claim | What it is |
|---|---|
| `iss` | Your issuer (`AUTH_ISSUER`). Tokens from other issuers are rejected. |
| `sub` | The subject you passed to `IssueSession` (usually the user id: `"42"` or a UUID). |
| `iat` | When the token was issued (Unix timestamp). |
| `exp` | Optional expiry. Only present if you set `SessionTTL`. Default is no expiry. |
| `purpose` | **Empty** for sessions. Reset/verify tokens set this, and session validation rejects them. |

The token is signed with HMAC-SHA256 using `JWTSecret`. Anyone with the secret can mint tokens, so keep it out of git and never send it to the frontend.

---

## Issuing a session

After successful login, registration, or OAuth, issue a session token:

```go
token, err := engine.IssueSession(fmt.Sprint(user.ID))
if err != nil {
    return err
}
```

The subject (`fmt.Sprint(user.ID)`) must match what your `LookupBySubject` expects. If you use UUIDs, pass `user.ID.String()` instead.

Return the token to the client:

```go
json.NewEncoder(w).Encode(map[string]any{
    "token": token,
})
```

The client stores it and sends `Authorization: Bearer <token>` on every request.

### Tokens with expiry

By default, sessions have no `exp` claim—they stay valid until you invalidate them (see "Log out" below). To issue a token that expires:

```go
token, err := engine.IssueSessionWithExpiry(fmt.Sprint(user.ID), 7*24*time.Hour)
```

This token expires after 7 days regardless of `SessionTTL` config. Expired tokens fail validation with `auth.ErrExpiredToken`.

---

## How validation works

When middleware or `ValidateSession` checks a token:

1. **Parse the JWT**: Verify signature with `JWTSecret`, check `iss` matches `Issuer`.
2. **Check expiry**: If `exp` is present, reject expired tokens.
3. **Reject purpose tokens**: If `purpose` is set, this is a reset/verify link, not a session → `ErrWrongPurpose`.
4. **Look up the user**: Middleware calls `LookupBySubject(db, claims.Subject)`. Missing user → unauthorized.
5. **Check cutoff**: If the user row has `sessions_valid_after`, reject tokens whose `iat` is before that timestamp.

Pass all checks → user is loaded onto `r.Context()`.

---

## Validating tokens outside middleware

If you need to check a token without HTTP (background jobs, websockets, etc.):

```go
claims, err := engine.ValidateSession(rawToken)
if err != nil {
    // Invalid, expired, wrong purpose, or bad signature
    return err
}

// claims.Subject is the user id
// Look up the user yourself if you need the full row
```

`ValidateSession` only validates the JWT. It does not look up the user or check `sessions_valid_after`. For that, call your own `LookupBySubject` or use middleware.

---

## Logging out

### Single device (client-only)

Delete the token from the client (clear localStorage, expire the cookie). The JWT is still technically valid, but the client won't send it anymore. This is enough for "log out on this browser."

### All devices (server-side)

Set `sessions_valid_after` on the user row to the current time. Every existing token has an older `iat`, so they all become invalid:

```go
cutoff := time.Now().UTC()
user.SessionsValidAfter = &cutoff
db.Model(user).Update("sessions_valid_after", cutoff)
```

Now every session issued before `cutoff` fails validation. Issue a new token for the current browser if they should stay logged in:

```go
token, err := engine.IssueSession(fmt.Sprint(user.ID))
// Return new token to client
```

**When to use this:**
- After password change (old sessions might be from an attacker)
- User clicks "log out all devices"
- After disabling 2FA (optional, depends on your security policy)

---

## Session rotation

`RotateSession` combines "invalidate old tokens" and "mint a new one" into one call:

```go
rotated, err := engine.RotateSession(fmt.Sprint(user.ID))
if err != nil {
    return err
}

// Persist the cutoff
db.Model(user).Update("sessions_valid_after", rotated.Cutoff)

// Return the new token to the client
json.NewEncoder(w).Encode(map[string]any{
    "token": rotated.Token,
})
```

`rotated.Cutoff` is the timestamp to store on `sessions_valid_after`. `rotated.Token` is the new JWT (same subject, fresh `iat`).

**Important:** Persist the cutoff **before** or together with returning the token. If the cutoff is in the future of the new token's `iat`, the brand-new token is already invalid.

---

## Token lifetimes

By default, `SessionTTL` is `0` and tokens have no `exp` claim. They stay valid forever (or until you rotate/revoke them).

Set a TTL if you want automatic expiry:

```go
cfg := auth.Config{
    JWTSecret:  secret,
    Issuer:     issuer,
    SessionTTL: 7 * 24 * time.Hour, // 7 days
}
```

Now every `IssueSession` call produces a token that expires after 7 days. Clients must log in again when it expires.

**Choosing a TTL strategy:**

| Strategy | TTL | `sessions_valid_after` | Use case |
|---|---|---|---|
| Long-lived | `0` (no expiry) | Optional, for logout | APIs, mobile apps, infrequent users |
| Short-lived | `7d` to `30d` | Rarely needed | Websites, active users |
| Hybrid | `1d` | Yes, for revocation | High-security apps |

Most applications use long-lived tokens with `sessions_valid_after` for targeted revocation.

---

## Cookies vs Authorization header

The middleware reads `Authorization: Bearer <token>`. It does **not** read cookies. If your app uses cookies:

1. Set the token as an `HttpOnly` cookie in your login handler.
2. Write a middleware wrapper that copies `cookie.Value` to the `Authorization` header.
3. Mount the wrapper before `JWTMiddleware` / `AuthMiddleware`.

Example:

```go
func cookieToBearer(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Header.Get("Authorization") == "" {
            if cookie, err := r.Cookie("token"); err == nil {
                r.Header.Set("Authorization", "Bearer "+cookie.Value)
            }
        }
        next.ServeHTTP(w, r)
    })
}

r.Use(cookieToBearer)
r.Use(engine.JWTMiddleware())
```

This keeps the auth package independent of cookie handling. See [Middleware](./middleware) for more details.

---

## Common issues

| Problem | Cause | Fix |
|---|---|---|
| Middleware always 401 after login | Client not sending `Authorization: Bearer …`. Cookies are ignored without a wrapper. | Check client code. Add cookie wrapper if using cookies. |
| Token works once, then guest | Client forgot to store the token, or middleware is `JWTMiddleware` (guests allowed). | Store token on client. Check which middleware you mounted. |
| Valid token rejected after password change | `sessions_valid_after` is newer than the token's `iat`. | Issue the new token **after** persisting the cutoff, or use `RotateSession`. |
| Reset link logs user in | Called `ValidateSession` on a purpose-scoped token. | Use `ValidateCredential` for reset/verify tokens. See [Email links](./credentials). |
| Wrong user logged in | `IssueSession` used wrong id, or `LookupBySubject` returns wrong user. | Check subject string and lookup query. |

---

## Testing with frozen time

Tests can inject a clock to make token expiry deterministic:

```go
now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
cfg := auth.Config{
    JWTSecret:  secret,
    Issuer:     issuer,
    SessionTTL: time.Hour,
    Now:        func() time.Time { return now },
}

engine, _ := auth.New[*User](cfg, db)
token, _ := engine.IssueSession("42")

// Token was issued at 2026-09-16 12:00, expires at 13:00
```

Production code leaves `Now` nil (uses wall clock).
