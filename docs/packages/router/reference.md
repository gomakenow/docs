---
title: Reference
description: Complete API reference for the router package.
---

# Reference

This page lists every exported type, function, and method. For how to use them, see the other pages.

---

## Types

```go
// Middleware wraps a handler. The first one passed to Use runs first.
type Middleware func(http.Handler) http.Handler

// Step changes one registered route. Steps run once, at startup.
type Step func(*mux.Route)

// CORS is the cross-origin policy for the root router.
type CORS struct {
    AllowedHeaders   []string
    AllowedMethods   []string
    AllowedOrigins   []string
    ExposedHeaders   []string
    AllowCredentials bool
    MaxAge           int
    OptionStatusCode int
    IgnoreOptions    bool
    OriginValidator  func(string) bool
}

type Router struct { /* embeds *mux.Router */ }
type Route struct  { /* embeds *mux.Route */ }
```

---

## Creating a router

| Function | Returns | Notes |
|---|---|---|
| `New()` | `*Router` | A new router on a new mux |
| `Wrap(parent *mux.Router)` | `*Router` | Wraps a mux router you already have |

---

## Root-only methods

| Method | Returns | Notes |
|---|---|---|
| `SetCORS(c CORS)` | `*Router` | Installs the CORS policy. Applied in `ServeHTTP` |
| `NotFound(h http.Handler)` | `*Router` | Handler for unmatched paths |
| `MethodNotAllowed(h http.Handler)` | `*Router` | Handler for a matched path with the wrong method |
| `ServeHTTP(w, req)` | | Applies CORS, then the mux. Serve this router |

---

## Middleware and groups

| Method | Returns | Notes |
|---|---|---|
| `Use(mw ...Middleware)` | `*Router` | Adds middleware to every route on this router. First one runs first. Skips `nil` |
| `Group(prefix string, mw ...Middleware)` | `*Router` | A sub-router under the prefix. An empty prefix keeps the parent path |

---

## Registering routes

| Method | Returns | Notes |
|---|---|---|
| `HandleFunc(path, f)` | `*Route` | Registers a handler function |
| `Handle(path, h)` | `*Route` | Registers an `http.Handler` |
| `PathPrefix(tpl)` | `*Route` | A route matching a prefix |
| `NewRoute()` | `*Route` | A blank route |

---

## Route matchers

All return `*Route`:

| Method | Notes |
|---|---|
| `Methods(methods ...string)` | Restricts to HTTP methods |
| `Path(tpl string)` | Sets the path template |
| `Headers(pairs ...string)` | Matches request headers |
| `Queries(pairs ...string)` | Matches query parameters |
| `Schemes(schemes ...string)` | Matches URL schemes |
| `Host(tpl string)` | Matches the host |
| `Name(name string)` | Names the route |

---

## Route chain

| Method | Returns | Notes |
|---|---|---|
| `Use(mw ...Middleware)` | `*Route` | Wraps the handler. Before or after the handler is set |
| `With(steps ...Step)` | `*Route` | Runs each step with the route, once, at startup. Skips `nil` |
| `Handler(h http.Handler)` | `*Route` | Sets the handler and applies `Use` middleware |
| `HandlerFunc(f)` | `*Route` | Same as `Handler` for a function |
| `Subrouter()` | `*Router` | A sub-router under this route. No CORS policy of its own |

---

## Rate limit

```go
func RateLimit(limit int, window time.Duration) Middleware
```

Allows `limit` requests per `window` for each client address. Returns `429` with `Retry-After` past the limit. Panics if `limit` is below 1 or `window` is not positive.

---

## Errors

The package does not return errors from registration. Bad arguments panic at startup, so a broken route stops the process before it serves any request.
