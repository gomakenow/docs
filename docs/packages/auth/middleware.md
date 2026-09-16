---
title: Middleware — Auth
description: HTTP middleware for session validation. Use the package middleware or write your own.
---

# Middleware

After a user logs in and receives a JWT, every protected request must validate that token and load the user. Middleware sits between the router and your handlers, checking the `Authorization: Bearer <token>` header before the request reaches your code.

The auth package provides two ready-to-use middleware functions, but you can also write your own if you need custom behavior (reading cookies, different error responses, request logging, etc.).

---

## Package middleware

The auth package exports `JWTMiddleware()` and `AuthMiddleware()` for immediate use. Both validate the session JWT and load the user onto `r.Context()`, but they differ in how they handle missing or invalid tokens.

### JWTMiddleware — Optional authentication

Use `JWTMiddleware` on routes where authentication is **optional**. Guests can access the page, but logged-in users get additional features or personalized content.

```go
r.Use(engine.JWTMiddleware())
r.Get("/products", listProducts)
```

**Behavior:**

- Token missing or invalid → request continues as a guest (`UserFromContext` returns `ok = false`)
- Token valid → user is loaded onto context
- Database nil or config error → returns 500

**Example use cases:**
- Product listing (show cart count for logged-in users)
- Home page (display username in header if authenticated)
- Blog posts (show "edit" button only to authors)

### AuthMiddleware — Required authentication

Use `AuthMiddleware` on routes that **require** authentication. Guests are blocked with a 401 before the handler runs.

```go
r.Group(func(r chi.Router) {
    r.Use(engine.AuthMiddleware())
    r.Get("/me", getProfile)
    r.Post("/orders", createOrder)
})
```

**Behavior:**

- Token missing or invalid → returns 401 immediately, handler never runs
- Token valid → user is loaded onto context
- Database nil or config error → returns 500

**Example use cases:**
- User profile (`/me`)
- Create order, edit settings
- Admin routes

### How the middleware works internally

Both middlewares follow the same validation flow:

1. **Read `Authorization` header**: Expects `Authorization: Bearer <jwt>`. Cookies are **not** read automatically. If you use cookies, see the cookie-handling section below.

2. **Parse and validate the JWT**:
   - Checks the HMAC signature against `JWTSecret`
   - Verifies `iss` matches `Issuer`
   - Checks `exp` if present (tokens only expire if you set `SessionTTL`)
   - Rejects tokens with a `purpose` claim (reset/verify links are not sessions)

3. **Look up the user**: Calls `user.LookupBySubject(db, claims.Subject)` using the `sub` from the JWT. Missing user → treated as invalid token.

4. **Check session cutoff**: If the user row has `sessions_valid_after` set, rejects tokens whose `iat` (issued-at) is before that timestamp. This is how "log out everywhere" works.

5. **Store on context**: Puts the user, identity, and claims on `r.Context()` via `ContextWithIdentity` and `ContextWithClaims`.

---

## Mounting the middleware

You can mount the middleware globally or on specific route groups.

### Global optional auth

```go
r := chi.NewRouter()
r.Use(engine.JWTMiddleware())

r.Get("/", homePage)
r.Get("/products", listProducts)
```

Every route now has optional authentication. Check `UserFromContext` in handlers to see if someone is logged in.

### Protected group

```go
r.Group(func(r chi.Router) {
    r.Use(engine.AuthMiddleware())
    
    r.Get("/me", getProfile)
    r.Post("/orders", createOrder)
})
```

Only authenticated requests reach these handlers.

### Mixed routes

```go
r := chi.NewRouter()

// Public routes with optional auth
r.Use(engine.JWTMiddleware())
r.Get("/", homePage)
r.Get("/products", listProducts)

// Protected routes
r.Group(func(r chi.Router) {
    r.Use(engine.AuthMiddleware())
    r.Get("/me", getProfile)
    r.Post("/orders", createOrder)
})
```

This is the most common pattern: optional auth on public pages, required auth on protected pages.

---

## Handling cookies

The middleware only reads `Authorization: Bearer <token>`. If your application uses cookies, copy the cookie to the `Authorization` header in a wrapper middleware:

```go
func cookieToBearer(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // If Authorization header is missing, check for a token cookie
        if r.Header.Get("Authorization") == "" {
            if cookie, err := r.Cookie("token"); err == nil {
                r.Header.Set("Authorization", "Bearer "+cookie.Value)
            }
        }
        next.ServeHTTP(w, r)
    })
}

// Mount the cookie wrapper before auth middleware
r.Use(cookieToBearer)
r.Use(engine.JWTMiddleware())
```

This pattern keeps the auth package independent of cookie handling while still supporting cookie-based sessions.

---

## Writing custom middleware

If you need different behavior—reading tokens from query params, custom error responses, logging, rate limiting—write your own middleware using the engine's public methods.

### Basic custom middleware

```go
func (h *Handler) customAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // 1. Read token from wherever you want
        token := r.Header.Get("Authorization")
        token = strings.TrimPrefix(token, "Bearer ")
        
        if token == "" {
            // Custom error response
            json.NewEncoder(w).Encode(map[string]string{
                "error": "missing_token",
                "message": "Authorization header required",
            })
            w.WriteHeader(http.StatusUnauthorized)
            return
        }
        
        // 2. Validate the session JWT
        claims, err := h.authEngine.ValidateSession(token)
        if err != nil {
            // Map auth errors to custom responses
            switch {
            case errors.Is(err, auth.ErrInvalidToken):
                json.NewEncoder(w).Encode(map[string]string{
                    "error": "invalid_token",
                })
            case errors.Is(err, auth.ErrExpiredToken):
                json.NewEncoder(w).Encode(map[string]string{
                    "error": "token_expired",
                })
            default:
                json.NewEncoder(w).Encode(map[string]string{
                    "error": "unauthorized",
                })
            }
            w.WriteHeader(http.StatusUnauthorized)
            return
        }
        
        // 3. Look up the user using your own query
        var user models.User
        err = h.db.Where("id = ?", claims.Subject).First(&user).Error
        if err != nil {
            w.WriteHeader(http.StatusUnauthorized)
            return
        }
        
        // 4. Check session cutoff if needed
        if user.SessionsValidAfter != nil {
            if claims.IssuedAt < user.SessionsValidAfter.Unix() {
                w.WriteHeader(http.StatusUnauthorized)
                return
            }
        }
        
        // 5. Build identity and store on context
        identity := auth.Identity[*models.User]{
            User:               &user,
            Subject:            claims.Subject,
            SessionsValidAfter: user.SessionsValidAfter,
        }
        
        ctx := auth.ContextWithIdentity(r.Context(), identity)
        ctx = auth.ContextWithClaims(ctx, claims)
        
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Reading from query params

```go
func (h *Handler) queryTokenAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Read token from ?token=... instead of Authorization header
        token := r.URL.Query().Get("token")
        
        if token == "" {
            http.Error(w, "missing token", http.StatusUnauthorized)
            return
        }
        
        // Same validation flow as above...
        claims, err := h.authEngine.ValidateSession(token)
        // ... rest of the middleware
    })
}
```

### Optional auth with custom behavior

```go
func (h *Handler) optionalAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        token = strings.TrimPrefix(token, "Bearer ")
        
        // If no token, continue as guest
        if token == "" {
            next.ServeHTTP(w, r)
            return
        }
        
        // Validate and load user
        claims, err := h.authEngine.ValidateSession(token)
        if err != nil {
            // Log the error but continue as guest
            log.Printf("invalid token: %v", err)
            next.ServeHTTP(w, r)
            return
        }
        
        var user models.User
        err = h.db.Where("id = ?", claims.Subject).First(&user).Error
        if err != nil {
            // User not found, continue as guest
            next.ServeHTTP(w, r)
            return
        }
        
        // Store on context
        identity := auth.Identity[*models.User]{
            User:    &user,
            Subject: claims.Subject,
        }
        ctx := auth.ContextWithIdentity(r.Context(), identity)
        ctx = auth.ContextWithClaims(ctx, claims)
        
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

---

## Storing on context

When writing custom middleware, use these helpers to store the user and claims so downstream handlers can read them with `UserFromContext`:

```go
// Store identity (user + auth metadata)
ctx = auth.ContextWithIdentity(r.Context(), identity)

// Store JWT claims
ctx = auth.ContextWithClaims(r.Context(), claims)

// Pass the updated context to the next handler
next.ServeHTTP(w, r.WithContext(ctx))
```

Handlers then read from context:

```go
user, ok := auth.UserFromContext[*models.User](r.Context())
claims, ok := auth.ClaimsFromContext(r.Context())
identity, ok := auth.IdentityFromContext[*models.User](r.Context())
```

---

## Common patterns

### Logging authenticated requests

```go
func (h *Handler) loggingAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        token = strings.TrimPrefix(token, "Bearer ")
        
        if token == "" {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        
        claims, err := h.authEngine.ValidateSession(token)
        if err != nil {
            http.Error(w, "invalid token", http.StatusUnauthorized)
            return
        }
        
        // Log the authenticated user
        log.Printf("user %s accessed %s", claims.Subject, r.URL.Path)
        
        // Load user and continue...
    })
}
```

### IP-based restrictions

```go
func (h *Handler) ipRestrictedAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Validate token first
        token := r.Header.Get("Authorization")
        token = strings.TrimPrefix(token, "Bearer ")
        
        claims, err := h.authEngine.ValidateSession(token)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        
        // Check IP allowlist for admin users
        var user models.User
        h.db.Where("id = ?", claims.Subject).First(&user)
        
        if user.Role == "admin" {
            clientIP := r.Header.Get("X-Real-IP")
            if !isAllowedIP(clientIP) {
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }
        }
        
        // Store and continue...
    })
}
```

---

## Comparison: Package vs Custom

| Feature | Package middleware | Custom middleware |
|---|---|---|
| JWT validation | ✓ Built-in | Call `engine.ValidateSession` |
| User lookup | ✓ Calls `LookupBySubject` | Write your own query |
| Session cutoff check | ✓ Built-in | Check `sessions_valid_after` yourself |
| Store on context | ✓ Automatic | Call `ContextWithIdentity` / `ContextWithClaims` |
| Cookie support | Need wrapper | You control where tokens come from |
| Custom errors | 401 with text | Full control over JSON / status |
| Logging / metrics | Not included | Add as needed |

Use the package middleware for most cases. Write custom middleware when you need:
- Tokens from cookies or query params
- Custom JSON error responses
- Request logging or metrics
- IP restrictions or rate limiting
- Different auth logic per route
