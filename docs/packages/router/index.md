---
title: Getting started
description: Put a login check, a rate limit, and a permission check on a route in one readable chain. Built on gorilla/mux.
---

# Getting started

<Badge type="info" text="No migrations required" />

Most routes need more than a path and a handler. A ticket list needs a logged-in user, a rate limit, and a permission check. With plain gorilla/mux, each of those is a separate wrapper around the handler. The wrappers nest, so the order only shows up when you read the code inside out. The rules for one route end up spread across a middleware stack, a group setup, and the handler file.

The `router` package is a thin layer over gorilla/mux that fixes this. You still register paths and handlers the same way. It adds one thing: you attach rules to a route, or to a group of routes, on the line where you declare the route. Rules run in the order you wrote them.

```go
r := router.New()
api := r.Group("/api", authRequired)
api.HandleFunc("/tickets", listTickets).
    Methods(http.MethodGet).
    Use(router.RateLimit(60, time.Minute)).
    With(guard.RequirePermission("ticket.list"))
```

Read it from top to bottom: the group requires a login, the route allows 60 requests a minute, and the user needs `ticket.list`.

The router gives you three ideas:

- **`Group`** — Shared rules for every route under a path.
- **`Use`** — A rule that wraps the request, such as a rate limit.
- **`With`** — A rule that works on the route, such as a permission check.

If a rule only looks at the request, use `Use`. If it needs the route, use `With`. Your own rule's documentation, or its type, tells you which one: a `Middleware` goes in `Use`, a `Step` goes in `With`.

In four steps, you build a router with a public route and a protected one.

::: info What router does not do
The package does not log users in, store sessions, or check permissions. `authRequired` and `guard.RequirePermission` are yours. The router only puts them in order. It has no login, session, or permission code of its own.
:::

---

## Step 1 — Create the router

```go
r := router.New()
```

Set the CORS policy once for the whole API:

```go
r := router.New()
r.SetCORS(router.CORS{
    AllowedHeaders: []string{"Content-Type", "Authorization"},
    AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
    AllowedOrigins: []string{"https://example.com"},
})
```

See [CORS and roots](./cors) for every field.

---

## Step 2 — Group the routes that share a rule

Put routes that need the same login check under one group:

```go
r := router.New()
api := r.Group("/api", authRequired)
```

`authRequired` is your app's login middleware. Every route added to `api` runs it first. A request without a login stops there, and nothing inside the group runs.

Routes that do not need a login go on `r` directly:

```go
r := router.New()
r.HandleFunc("/health", health).Methods(http.MethodGet)
```

---

## Step 3 — Add a route with its rules

```go
api.HandleFunc("/tickets", listTickets).
    Methods(http.MethodGet).
    Use(router.RateLimit(60, time.Minute)).
    With(guard.RequirePermission("ticket.list"))
```

| Part | What it does |
|---|---|
| `HandleFunc` | Sets the path and the handler |
| `Methods` | Limits the route to `GET`. Without it, the route answers every method |
| `Use(RateLimit)` | Allows 60 requests a minute from one client. Past that, the answer is `429` |
| `With(guard.RequirePermission)` | Checks the permission on every request. Without the permission, the answer is `403` |

Each rule runs in order. A request that fails an earlier rule never reaches the later ones.

---

## Step 4 — Start the server

The root router is the `http.Handler`. It applies CORS and dispatches to every group.

```go
r := router.New()
log.Fatal(http.ListenAndServe(":8080", r))
```

---

## What happens to a request

For the `/tickets` route above, a request goes through these stages in order:

| Stage | What runs | If it stops the request |
|---|---|---|
| 1 | The root router applies the CORS policy | A preflight `OPTIONS` request is answered here |
| 2 | gorilla/mux matches the path and method | No match gives the not-found or method-not-allowed handler |
| 3 | The group's rules, such as `authRequired` | The rule writes its own response, and nothing after it runs |
| 4 | The route's `Use` middleware, such as `RateLimit` | `RateLimit` answers `429` with a `Retry-After` header |
| 5 | The route's `With` steps, such as `guard.RequirePermission` | The step writes its own response |
| 6 | Your handler | — |

A rule continues the request by calling the next handler. It stops the request by returning without calling it. The status code is whatever the rule writes, so `401` and `403` come from `authRequired` and `guard.RequirePermission`. The router itself only produces `429`, the not-found and method-not-allowed responses, and the CORS preflight answer.

A rule that stops the request ends the chain. Later rules do not see it, and the rate limit counts only the requests that reach it.

---

## What's next

| Page | What you'll find |
|---|---|
| [Chaining](./chaining) | `Use` and `With` in detail, and when each one runs |
| [Groups](./groups) | Prefixes, nested groups, and shared rules |
| [Middleware and rate limits](./middleware) | Writing your own rule, how `RateLimit` counts, and how `AllowRequestSize` raises the body cap |
| [CORS and roots](./cors) | Every CORS field, and the not-found and method-not-allowed handlers |
| [Reference](./reference) | Every type, function, and method |
| [Testing](./testing) | Running the package tests, and testing your own routes |
