---
title: Middleware and rate limits
description: What a middleware is, how to write one, and how the built-in Throttle and AllowRequestSize behave.
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

`router.Throttle` and `router.AllowRequestSize` are built this way.

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

## Throttle

```go
func Throttle(max float64, burst int, excludePaths []string) router.Middleware
```

`max` is requests per second. `burst` is how many requests can arrive at once before that rate applies. A `burst` of `0` keeps the default, which is at least 1 and otherwise equal to `max`. A client's entry expires after one minute. Pass the result to `Use`.

`excludePaths` are request paths that skip the limit and are not counted. The match is exact. `nil` excludes nothing.

```go
r := router.New()
r.Use(router.Throttle(180, 180, []string{"/mcp"}))

r.HandleFunc("/contact", contact).
    Methods(http.MethodPost).
    Use(router.Throttle(1, 10, nil))
```

This allows a burst of 10, then about one request a second from each client. The next request gets `429` and never reaches `contact`:

```
HTTP/1.1 429 Too Many Requests

You have reached maximum request limit.
```

### What counts as one client

The client is the `CF-Connecting-IP` header when that header is set. Otherwise it is the host part of `RemoteAddr`, so the IP address without the port. All requests from one IP share one counter, whatever port they come from. An address that yields no host is counted as `0.0.0.0`.

`RemoteAddr` is the address of whoever opened the connection to your server. Behind Cloudflare, `CF-Connecting-IP` is the visitor. The limiter does not read `X-Forwarded-For`.

### One counter per call

Each call to `router.Throttle` creates its own set of counters. Reuse the middleware value when two routes should share one:

```go
r := router.New()

limit := router.Throttle(1, 60, nil)
r.HandleFunc("/a", a).Use(limit)
r.HandleFunc("/b", b).Use(limit)
// /a and /b share one counter.

r.HandleFunc("/c", c).Use(router.Throttle(1, 60, nil))
r.HandleFunc("/d", d).Use(router.Throttle(1, 60, nil))
// /c and /d each have their own counter.
```

Passing one `Throttle` result to a group shares that counter across every route in the group.

### Where the counters live

The counters are in the memory of the running process. This has three effects:

- With two servers behind a load balancer, each one counts on its own, so a client can spend the full burst on each.
- A restart clears every counter.
- A client's entry is removed after one minute, so memory does not keep growing with old clients.

---

## AllowRequestSize

```go
func AllowRequestSize(max int64) router.Middleware
```

`AllowRequestSize` raises the request body cap for one route. The server puts a default cap on every body. A handler cannot raise that cap by wrapping the body in another `http.MaxBytesReader`. This middleware raises it before anything reads the body, then stops the body at `max`.

```go
r := router.New()
r.HandleFunc("/media", upload).
    Methods(http.MethodPost).
    Use(router.AllowRequestSize(201 << 20)).
    With(guard.RequirePermission("media.upload"))
```

The middleware does not read the body, and it does not write a response. When the body is larger than `max`, the read inside the handler fails.

`Use` sits outside `With`, so the cap is raised before a permission step runs. The step can still reject the request, and the handler never reads the body.

Put it on the routes that accept an upload. A group `Use` would raise the cap for every route in that group.

A few details follow from how the cap works:

- The raise applies only while the body is still unread. The middleware runs before the handler, so the body is unread when it runs.
- A smaller `max` tightens the cap for that route. `0` or less allows no bytes.
- Passing the same middleware to several routes gives each of them that cap. There is no shared counter.
