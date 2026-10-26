---
title: Middleware and rate limits
description: What a middleware is, how to write one, and how the built-in RateLimit counts requests.
---

# Middleware and rate limits

A middleware is a function that sits in front of a handler. It sees the request first and decides what happens next: let it through, or answer it right there.

The router uses the standard Go shape for this:

```go
type Middleware func(http.Handler) http.Handler
```

It takes the next handler and returns a new handler that wraps it. Any function with that shape works, including ones from other libraries. You hand it to the router with `Use`, on a route or on a group.

---

## Writing a middleware

This one only lets a request through when a header is present:

```go
func requireKey(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Header.Get("X-Api-Key") == "" {
            http.Error(w, "missing key", http.StatusUnauthorized)
            return
        }
        next.ServeHTTP(w, r)
    })
}

r := router.New()
r.HandleFunc("/reports", reports).
    Methods(http.MethodGet).
    Use(requireKey)
```

There are only two outcomes:

- **Call `next.ServeHTTP(w, r)`.** The request moves on to the next middleware, or to your handler if there is none left.
- **Return without calling it.** The request stops here. Whatever you wrote to `w` is the answer, and nothing after this middleware runs.

A middleware can also do work around the call. For example, it can note the time before `next.ServeHTTP` and log how long it took after:

```go
func timed(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Println(r.URL.Path, time.Since(start))
    })
}
```

---

## A middleware that needs settings

When a middleware needs a value, such as a limit or a header name, write a function that takes the value and returns the middleware:

```go
func requireHeader(name string) router.Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if r.Header.Get(name) == "" {
                http.Error(w, "missing "+name, http.StatusBadRequest)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

r := router.New()
r.HandleFunc("/reports", reports).Use(requireHeader("X-Api-Key"))
```

`router.RateLimit` is built this way.

---

## Where middleware can go

| Where | Call | Runs for |
|---|---|---|
| One route | `route.Use(mw)` | That route |
| A group | `r.Group("/admin", mw)` or `group.Use(mw)` | Every route in the group |

When you pass several, the first one is outermost. Group middleware is outside route middleware. The [Chaining](./chaining.md) and [Groups](./groups.md) pages show the full order.

A `nil` middleware is skipped, so a variable that may be empty can go straight into `Use`:

```go
var audit router.Middleware // nil

r := router.New()
r.HandleFunc("/export", export).Methods(http.MethodGet).Use(audit)
```

---

## RateLimit

```go
func RateLimit(limit int, window time.Duration) router.Middleware
```

`RateLimit` is a middleware that limits how many requests one client can make in a period of time.

```go
r := router.New()
r.HandleFunc("/contact", contact).
    Methods(http.MethodPost).
    Use(router.RateLimit(10, time.Minute))
```

This allows 10 requests per minute from each client. The 11th request in that minute gets this answer instead of reaching `contact`:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60

too many requests
```

### How it counts

The limiter uses a **fixed window**, kept separately for each client.

1. A client's first request opens a window and counts as 1.
2. Every request after that, until the window ends, adds 1.
3. While the count is at or under the limit, the request goes through. Over the limit, it gets `429`.
4. When `window` has passed since the first request, the client's counter is forgotten. The next request opens a new window.

With `RateLimit(3, time.Minute)`, a client that sends requests at seconds 0, 10, 20, 30, and 40 gets this:

| Second | Request | Result |
|---|---|---|
| 0 | 1st | Goes through. The window opens |
| 10 | 2nd | Goes through |
| 20 | 3rd | Goes through |
| 30 | 4th | `429` |
| 40 | 5th | `429` |
| 60 | 6th | Goes through. A new window opens |

Two details follow from this:

- **The window does not move.** It starts at the first request and ends `window` later. Requests that get a `429` still count, but they do not push the end of the window back.
- **`Retry-After` is the full window length in seconds**, with a minimum of 1. It does not shrink as the window runs out. For `time.Minute` it is always `60`.

### What counts as one client

The client is the host part of `RemoteAddr`, so the IP address without the port. All requests from one IP share one counter, whatever port they come from.

`RemoteAddr` is the address of whoever opened the connection to your server. If a reverse proxy sits in front of the server, that is the proxy's address, and every user shares one counter. The limiter does not read `X-Forwarded-For` or any other header.

### One counter per RateLimit call

Each call to `router.RateLimit(...)` creates its own set of counters. Where you use the result decides what shares them:

```go
r := router.New()

limit := router.RateLimit(60, time.Minute)
r.HandleFunc("/a", a).Use(limit)
r.HandleFunc("/b", b).Use(limit)
// /a and /b share one counter. 60 requests a minute across both.

r.HandleFunc("/c", c).Use(router.RateLimit(60, time.Minute))
r.HandleFunc("/d", d).Use(router.RateLimit(60, time.Minute))
// /c and /d each have their own counter. 60 a minute on each.
```

Passing it to a group shares one counter across every route in that group.

### Where the counters live

The counters are in the memory of the running process. This has three effects:

- With two servers behind a load balancer, each one counts on its own, so a client can make the full `limit` on each.
- A restart clears every counter.
- A client's entry is removed once its window ends, so memory does not keep growing with old clients.

### Bad arguments

`RateLimit` checks its arguments when you call it, which happens at startup when you declare the route:

| Argument | Rule | If broken |
|---|---|---|
| `limit` | At least 1 | Panics with `router: rate limit must be at least 1` |
| `window` | Greater than zero | Panics with `router: rate limit window must be positive` |
