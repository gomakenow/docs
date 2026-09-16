---
title: 2FA and OAuth — Auth
description: TOTP two-factor authentication and OAuth CSRF protection. You write the routes; the package handles the crypto.
---

# 2FA and OAuth

The auth package provides primitives for two common authentication features: time-based one-time passwords (authenticator apps like Google Authenticator) and signed OAuth state for CSRF protection. Neither feature talks to external services—you still write the HTTP routes and the Google/GitHub integration.

---

## Two-factor authentication (TOTP)

TOTP works by sharing a secret between your server and the user's authenticator app. Every 30 seconds, both sides compute the same six-digit code using that secret and the current time.

### How it fits into login

`Attempt` already handles 2FA. When `Identity.TwoFactorSecret` is set, it checks the TOTP code:

```go
result, err := engine.Attempt(email, password, totpCode)
if err != nil {
    switch {
    case errors.Is(err, auth.ErrTwoFactorRequired):
        // Password correct, but 2FA is on and no code sent
    case errors.Is(err, auth.ErrInvalidOTP):
        // Password correct, but TOTP code wrong
    }
}
```

Your job is to get that secret into `Identity.TwoFactorSecret` in the first place.

### Requirements

Two config values control TOTP:

```bash
AUTH_APP_KEY=base64:your-32-byte-key-here  # Encrypts TOTP secrets
AUTH_APP_NAME=YourApp                       # Label in authenticator
```

`AUTH_APP_KEY` must be exactly 32 bytes (encode with base64). Generate it once and keep it secret. Changing it invalidates all enrolled TOTP secrets.

---

## Enabling 2FA for a user

### Step 1: Generate a secret and show the QR code

When a logged-in user clicks "Enable 2FA":

```go
enroll, err := engine.BeginTOTP(user.Email)
if err != nil {
    return err
}
```

`BeginTOTP` returns:

| Field | What it is |
|---|---|
| `Secret` | Plaintext secret (16-character base32 string) |
| `URL` | `otpauth://totp/...` URI for the QR code |
| `QRPNG` | QR code as PNG bytes |
| `QRBase64` | Base64-encoded PNG (ready for data URLs) |

Display the QR code to the user:

```go
// Option 1: Send PNG bytes
w.Header().Set("Content-Type", "image/png")
w.Write(enroll.QRPNG)

// Option 2: Embed in HTML as data URL
fmt.Fprintf(w, `<img src="data:image/png;base64,%s">`, enroll.QRBase64)
```

Show a text input for them to enter the six-digit code. **Do not save `enroll.Secret` to the database yet.** If you save it before they confirm, they'll be locked out (2FA on but they never scanned the QR).

### Step 2: Confirm the first code

When they submit a code:

```go
encrypted, err := engine.ConfirmTOTP(codeFromForm, enroll.Secret)
if err != nil {
    // auth.ErrInvalidOTP - code was wrong, let them retry
    return err
}

// Store the encrypted secret
db.Model(&user).Update("two_factor_secret", encrypted)
```

`ConfirmTOTP` does two things:
1. Validates the code against the secret (with ±1 time-step tolerance)
2. Encrypts the secret with `AUTH_APP_KEY` and returns it

Store the **encrypted** value, not `enroll.Secret`.

### Step 3: Generate and show recovery codes

Always give users recovery codes when enabling 2FA:

```go
plain, hashed, err := auth.GenerateRecoveryCodes(8)
if err != nil {
    return err
}

// Show `plain` to the user once (e.g. 8 codes like "a1b2c-d3e4f")
// Store `hashed` on the user row
db.Model(&user).Update("recovery_codes", hashed)
```

`GenerateRecoveryCodes(n)` returns `n` random codes (default 8). `plain` is what the user copies down. `hashed` is bcrypt-hashed versions you store.

Recovery codes are one-time. When a user logs in with one, `Attempt` returns `UsedRecovery = true` and `RemainingRecovery` (the list minus the used code). You must persist the remaining codes.

---

## Validating TOTP outside login

For actions that require confirmation (disable 2FA, withdraw funds, change email), validate a fresh code:

```go
ok, err := engine.ValidateTOTP(codeFromUser, user.TwoFactorSecret)
if err != nil {
    // Decryption failed (bad APP_KEY or corrupted secret)
    return err
}
if !ok {
    // Wrong code
    return errors.New("invalid code")
}
```

`user.TwoFactorSecret` is the **encrypted** value from the database. The engine decrypts it with `AUTH_APP_KEY`.

---

## Disabling 2FA

Ask for one last code (or a recovery code) before turning 2FA off:

```go
ok, err := engine.ValidateTOTP(code, user.TwoFactorSecret)
if !ok || err != nil {
    return errors.New("invalid code")
}

// Clear 2FA fields
db.Model(&user).Updates(map[string]any{
    "two_factor_secret": nil,
    "recovery_codes":    nil,
})

// Optional: Log out all devices
cutoff := time.Now().UTC()
db.Model(&user).Update("sessions_valid_after", cutoff)
```

Setting `sessions_valid_after` forces re-login everywhere. Some apps do this after disabling 2FA for security.

---

## Recovery codes in login

When a user logs in with a recovery code instead of a TOTP:

```go
result, err := engine.Attempt(email, password, recoveryCode)
if err != nil {
    return err
}

if result.UsedRecovery {
    // Recovery code was used—update the stored list
    db.Model(&models.User{}).
        Where("id = ?", result.Identity.User.ID).
        Update("recovery_codes", result.RemainingRecovery)
}
```

`RemainingRecovery` is the list with the used code removed. If you don't persist it, the same code works multiple times (security issue).

---

## Manual encryption

`engine.Encrypt` and `engine.Decrypt` are available for any secrets you want to store (API keys, tokens, etc.):

```go
ciphertext, err := engine.Encrypt(plaintext)
// Store ciphertext in DB

plain, err := engine.Decrypt(ciphertext)
```

This is AES-CBC with a random IV, suitable for small secrets (under ~10 KB). Not for passwords—use `auth.Hash` for those.

**Key rotation:** Changing `AUTH_APP_KEY` breaks all encrypted values. If you rotate, decrypt everything with the old key and re-encrypt with the new one.

---

## OAuth CSRF protection

OAuth flows redirect users to Google/GitHub/etc., then back to your callback. Attackers can start a flow and trick a victim into finishing it, hijacking the OAuth session. The defense: sign a `state` parameter that only you can verify.

### Step 1: Redirect to the provider

```go
state, err := engine.SignOAuthState("google")
if err != nil {
    return err
}

// Redirect to Google with state
redirectURL := fmt.Sprintf(
    "https://accounts.google.com/o/oauth2/auth?client_id=%s&redirect_uri=%s&state=%s",
    clientID, callbackURL, url.QueryEscape(state),
)
http.Redirect(w, r, redirectURL, http.StatusFound)
```

`SignOAuthState(audience)` creates an HMAC-signed blob with a 10-minute expiry (configurable via `AUTH_STATE_TTL`). The `audience` is usually the provider name (`"google"`, `"github"`).

### Step 2: Validate on callback

```go
stateFromQuery := r.URL.Query().Get("state")
err := engine.ValidateOAuthState(stateFromQuery, "google")
if err != nil {
    // Forged, expired, or audience mismatch
    http.Error(w, "invalid state", http.StatusBadRequest)
    return
}

// State is valid—exchange the code
```

`ValidateOAuthState` checks:
1. HMAC signature
2. Expiry (default 10 minutes)
3. Audience matches what you passed

The audience must match on both sides. `"Google"` vs `"google"` fails.

### What you still write

The auth package only signs and validates `state`. You still write:

- Redirect URLs to Google/GitHub
- Client ID and secret management
- Code exchange (get access token)
- Fetching user profile from the provider
- Finding or creating the user in your DB
- Issuing a session after successful OAuth

Example full flow:

```go
// Login route
func (h *Handler) GoogleLogin(w http.ResponseWriter, r *http.Request) {
    state, _ := h.authEngine.SignOAuthState("google")
    
    url := fmt.Sprintf(
        "https://accounts.google.com/o/oauth2/auth?client_id=%s&redirect_uri=%s&state=%s&scope=email+profile",
        h.googleClientID, h.callbackURL, state,
    )
    http.Redirect(w, r, url, http.StatusFound)
}

// Callback route
func (h *Handler) GoogleCallback(w http.ResponseWriter, r *http.Request) {
    // Validate state
    err := h.authEngine.ValidateOAuthState(r.URL.Query().Get("state"), "google")
    if err != nil {
        http.Error(w, "invalid state", http.StatusBadRequest)
        return
    }
    
    // Exchange code for tokens
    code := r.URL.Query().Get("code")
    googleUser := exchangeCodeForProfile(code) // Your implementation
    
    // Find or create user
    user := findOrCreateUser(googleUser.Email)
    
    // Issue session
    token, _ := h.authEngine.IssueSession(fmt.Sprint(user.ID))
    json.NewEncoder(w).Encode(map[string]any{"token": token})
}
```

---

## Configuration

| Config | Env | Default | Used for |
|---|---|---|---|
| `AppKey` | `AUTH_APP_KEY` | (required) | Encrypting TOTP secrets |
| `AppName` | `AUTH_APP_NAME` | `"App"` | Label in authenticator |
| `StateTTL` | `AUTH_STATE_TTL` | `10m` | OAuth state expiry |
| `OAuthStateSecret` | (none) | `JWTSecret` | Optional separate HMAC key for OAuth |

---

## Common issues

| Problem | Cause | Fix |
|---|---|---|
| Authenticator codes always fail | Clock skew on server or phone. Stored plaintext instead of encrypted. Old QR scanned. | Check server time. Store output of `ConfirmTOTP`, not `enroll.Secret`. |
| User locked out after enabling 2FA | Stored secret before confirming the code | Only persist after `ConfirmTOTP` succeeds |
| Recovery code works multiple times | Didn't persist `RemainingRecovery` after use | Update user row with `result.RemainingRecovery` |
| OAuth state invalid on callback | State truncated in redirect. Expired (took >10min). Wrong audience. | Check URL encoding. Increase `StateTTL` if needed. Match audience exactly. |
| Session created before user lookup | Issued session from `state` alone | Always fetch profile and find/create user before `IssueSession` |
| `ValidateTOTP` fails with decrypt error | `APP_KEY` changed or wrong. Corrupted database value. | Check key. Re-enroll users if key rotated. |

---

## Best practices

**Show recovery codes once**: After enrollment, display them in a modal with "Download" or "Print" buttons. Never show them again.

**Require password before disabling**: Always validate the current password (and optionally a TOTP code) before turning 2FA off.

**Optional 2FA**: Don't force all users to enable it unless required by your security policy. Make it opt-in with clear benefits.

**Backup codes count**: 8-10 codes is standard. Fewer is risky; more is hard to manage.

**Log out after 2FA changes**: Set `sessions_valid_after` when enabling or disabling 2FA so old sessions are invalidated.

**OAuth state timeout**: 10 minutes is usually enough. If users spend a long time on the consent screen, increase `StateTTL`.

**Separate OAuth secret**: For high-security apps, set `OAuthStateSecret` instead of reusing `JWTSecret`. This limits blast radius if one key leaks.
