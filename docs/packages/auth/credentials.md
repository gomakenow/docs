---
title: Email links — Auth
description: Password-reset and email-verification tokens. You send the email; the package mints and validates the JWT.
---

# Email links

Password-reset and email-verification links work the same way: mint a short-lived JWT with a `purpose` claim, put it in a URL, and email it to the user. When they click the link, validate the token and take action (reset password, mark email verified).

The auth package handles the token part. You handle the email part—HTML, sending, and the HTTP routes that process the link.

---

## How they differ from sessions

| | Session token | Reset/verify token |
|---|---|---|
| `purpose` claim | Empty | `password_reset` or `email_verification` |
| Lifetime | Optional (default: none) | 1 hour (reset) or 48 hours (verify) |
| Stored? | No | Reset: SHA-256 digest in `password_reset_tokens`. Verify: no. |
| Accepted by middleware? | Yes | No—rejected with `ErrWrongPurpose` |

Reset/verify tokens are **not** sessions. If a user tries to use one as `Authorization: Bearer`, the middleware rejects it. This prevents reset links from granting login access.

---

## Password reset flow

### Step 1: User submits "forgot password"

When a user requests a password reset:

```go
link, err := engine.GenerateReset(db, user.Email)
if err != nil {
    return err
}

// link.Token  → raw JWT (do not log this)
// link.Link   → https://example.com/reset-password?token=...
// link.Digest → SHA-256 hex (already stored in password_reset_tokens)
```

`GenerateReset` does three things:
1. Issues a JWT with `purpose = "password_reset"` and `exp = now + 1 hour`
2. Stores a SHA-256 digest of the token in `password_reset_tokens` (one row per email)
3. Builds the complete URL you'll email

Only one reset token exists per email address. A second call replaces the previous one.

Queue an email with a button pointing to `link.Link`. The URL format is:

```
{AUTH_BASE_URL or AUTH_ISSUER} + /reset-password + ?token={jwt}
```

Set `AUTH_BASE_URL` to your frontend origin if it's different from the API host.

### Step 2: User clicks the link and submits new password

When they load the form, the token is in `?token=...`. On form submit:

```go
claims, err := engine.ConsumeResetToken(db, rawToken)
if err != nil {
    // Token expired, invalid, forged, or already used
    return err
}

// claims.Subject is the email address (lowercased)
hash, err := auth.Hash(newPassword)
if err != nil {
    return err
}

db.Model(&User{}).Where("email = ?", claims.Subject).Update("password", hash)
```

`ConsumeResetToken` validates the JWT **and** deletes the digest row. A second submit with the same token fails with `auth.ErrInvalidResetToken`.

**Optional:** Set `sessions_valid_after = now` to log out all devices after the password change.

### Validating before consuming

If you want to show the form on GET before consuming the token on POST:

```go
// GET /reset-password?token=...
claims, err := engine.ValidateCredential(rawToken, auth.PurposePasswordReset)
if err != nil {
    // Show "invalid or expired link" page
    return
}
// Show the form

// POST /reset-password
claims, err := engine.ConsumeResetToken(db, rawToken)
// Now actually consume it
```

---

## Email verification flow

### Step 1: Issue a verification link

After registration or when a user requests to resend verification:

```go
link, err := engine.GenerateVerification(fmt.Sprint(user.ID))
if err != nil {
    return err
}

// Email link.Link to the user
```

Verification tokens are **not** stored in the database. The JWT itself is the proof. Anyone with the link can verify until it expires (48 hours by default).

The subject is usually the user ID (not the email), so you can verify even if they change their email before clicking.

### Step 2: User clicks the link

```go
claims, err := engine.ValidateCredential(rawToken, auth.PurposeEmailVerification)
if err != nil {
    // Expired or invalid
    return err
}

// claims.Subject is what you passed (user ID)
db.Model(&User{}).Where("id = ?", claims.Subject).Update("email_verified_at", time.Now())
```

After marking verified, issue a session token so they're logged in:

```go
token, err := engine.IssueSession(claims.Subject)
// Return token to client
```

---

## Manual token issuance

`GenerateReset` and `GenerateVerification` are convenience methods. Under the hood they call `IssueCredential`. Use that directly when you need:

- A custom purpose (invite links, magic login, etc.)
- Transactional consistency (store digest and queue email in the same transaction)
- Manual URL building

### Custom purpose

```go
// Define a TTL for your purpose
cfg := auth.Config{
    JWTSecret: secret,
    Issuer:    issuer,
    CredentialTTL: map[string]time.Duration{
        "invite": 72 * time.Hour,
    },
}

// Issue a token
token, err := engine.IssueCredential("invite", inviteeEmail)
```

Unknown purposes return `auth.ErrUnknownPurpose`.

### Transactional reset

Store the digest and queue the email in the same transaction so a crash can't leave inconsistent state:

```go
token, err := engine.IssueCredential(auth.PurposePasswordReset, user.Email)
if err != nil {
    return err
}

err = db.Transaction(func(tx *gorm.DB) error {
    // Store the digest
    if err := auth.StoreReset(tx, user.Email, token); err != nil {
        return err
    }
    
    // Queue the email job
    return queueResetEmail(tx, user.Email, token)
})
```

`auth.StoreReset` writes the SHA-256 digest to `password_reset_tokens`. The raw JWT only goes in the email.

---

## Validation without consuming

To validate a credential token without deleting it:

```go
claims, err := engine.ValidateCredential(rawToken, auth.PurposePasswordReset)
if err != nil {
    // Invalid, expired, or wrong purpose
    return err
}

// claims.Subject, claims.ExpiresAt, etc.
```

This checks the signature, issuer, expiry, and purpose. It does **not** check `password_reset_tokens`. For reset tokens, you must still consume the digest to make them one-time.

For verify tokens, `ValidateCredential` is all you need (no digest to consume).

---

## Errors

| Error | Meaning |
|---|---|
| `ErrWrongPurpose` | JWT purpose doesn't match what you asked for, or you used `ValidateSession` on a credential token |
| `ErrExpiredToken` | `exp` is in the past |
| `ErrInvalidToken` | Bad signature, malformed JWT, or wrong issuer |
| `ErrInvalidResetToken` | Digest row missing (never issued or already consumed) |
| `ErrUnknownPurpose` | You called `IssueCredential` with a purpose that isn't built-in and not in `CredentialTTL` |

---

## What you still own

The auth package handles tokens. You handle:

- **HTTP routes**: `POST /forgot-password`, `GET /reset-password`, `GET /verify-email`
- **Email HTML**: Subject line, button text, expiry notice
- **Sending**: Queueing the email job (see [mailing](/packages/mailing/))
- **Rate limiting**: Forgot-password spam prevention
- **Success actions**: Updating `password`, setting `email_verified_at`, invalidating sessions
- **UI**: Forms, error pages, success pages

The package does not decide whether to return 200 or 404 for missing emails on forgot-password. Most apps return 200 regardless to avoid email enumeration.

---

## Configuration

| Config key | Env | Default | What it controls |
|---|---|---|---|
| `ResetTTL` | `AUTH_RESET_TTL` | `1h` | How long reset tokens live |
| `VerifyTTL` | `AUTH_VERIFY_TTL` | `48h` | How long verify tokens live |
| `BaseURL` | `AUTH_BASE_URL` | `Issuer` | Origin for building links |
| `ResetPath` | `AUTH_RESET_PATH` | `/reset-password` | Path appended to base URL |
| `VerifyPath` | `AUTH_VERIFY_PATH` | `/verify-email` | Path appended to base URL |
| `TokenQuery` | `AUTH_TOKEN_QUERY` | `token` | Query param name |

Full link structure:

```
{BaseURL}/{ResetPath}?{TokenQuery}={jwt}
```

Example: `https://example.com/reset-password?token=eyJ...`

---

## Common issues

| Problem | Cause | Fix |
|---|---|---|
| Link 404s in browser | `BaseURL` points to API host, or `ResetPath` doesn't match frontend route | Set `BaseURL` to frontend origin. Check route config. |
| Second click fails | Expected—`ConsumeResetToken` deleted the digest | Show "link already used" message. |
| Token works in logs but email URL is broken | Full JWT logged (security issue). Some mail clients wrap long URLs. | Never log raw tokens. Keep paths short. |
| Verify link rejected as `ErrWrongPurpose` | Called `ValidateSession` instead of `ValidateCredential` | Use `ValidateCredential` with the correct purpose. |
| Reset works without database row | Only called `ValidateCredential`, didn't consume digest | Use `ConsumeResetToken` for reset tokens. |
| Compile error on `IssueCredential` | Argument order is purpose first, then subject | `IssueCredential(purpose, subject)` not `(subject, purpose)` |

---

## Best practices

**Rate limit forgot-password**: Attackers can spam reset emails. Limit to 3-5 per hour per IP or email.

**Return 200 for missing emails**: Don't leak whether an email is registered. Queue a "no account" email or return success either way.

**Short TTL for reset, longer for verify**: Users reset passwords immediately. Email verification can wait (they might check hours later).

**Log out on password change**: Set `sessions_valid_after` after consuming a reset token so attackers lose access.

**Never log raw tokens**: They're credentials. Log `token=<redacted>` or the digest.

**Frontend routes must match paths**: If `ResetPath = /reset-password`, your frontend must serve that route.
