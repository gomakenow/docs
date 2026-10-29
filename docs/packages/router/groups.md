---
title: Groups
description: How Group puts routes under a shared path prefix and shared middleware, and how groups nest.
---

# Groups

A group is a bundle of routes that share two things: a path prefix and a list of middleware. You create it once, then register routes on it.

```go
r := router.New()
admin := r.Group("/admin", requireLogin, requireAdmin)

admin.HandleFunc("/users", listUsers).Methods(http.MethodGet)
admin.HandleFunc("/roles", listRoles).Methods(http.MethodGet)
```

The two routes are served at `/admin/users` and `/admin/roles`. A request to either one goes through `requireLogin`, then `requireAdmin`, then the handler. You wrote the middleware once, and it applies to both routes.

---

## How Group works

```go
func (r *Router) Group(prefix string, mw ...Middleware) *Router
```

| Argument | What it does |
|---|---|
| `prefix` | The path put in front of every route you register on the group |
| `mw` | Middleware for every route in the group. The first one passed runs first. A `nil` is skipped |

`Group` returns a `*Router`. That is the same type as the root router, so a group has the same methods: `HandleFunc`, `Handle`, `PathPrefix`, `NewRoute`, `Use`, and `Group` itself. Every route you register on it still returns a chainable route, so `Use` and `With` work as described on the [Chaining](./chaining.md) page.

Under the hood, a group is a gorilla/mux sub-router mounted on the prefix.

---

## Group without a prefix

If you pass an empty string as the prefix, the group does not change the path. It only carries the middleware.

```go
r := router.New()
authed := r.Group("", requireLogin)

authed.HandleFunc("/me", me).Methods(http.MethodGet)
// Served at /me
```

---

## Group middleware and route middleware

The group's middleware sits outside the route's own `Use` middleware. A request passes through the group first, then through the route's `Use` middleware, then through the route's `With` steps, then it reaches the handler.

```go
r := router.New()
admin := r.Group("/admin", requireLogin)

admin.HandleFunc("/export", export).
    Methods(http.MethodGet).
    Use(router.Throttle(1, 5, nil)).
    With(requirePermission)
```

```
request → requireLogin → Throttle → requirePermission → export
          (group)        (route Use)  (route With)
```

Group middleware belongs to the group, not to a single route. Each route can add more on top of it, and none of them can remove what the group applies.

---

## Nested groups

A group can have groups inside it. The prefixes are joined, and the middleware runs from the outside in.

```go
r := router.New()
api := r.Group("/api", requireLogin)
v1 := api.Group("/v1", logRequests)

v1.HandleFunc("/tickets", listTickets).Methods(http.MethodGet)
// Served at /api/v1/tickets
```

```
request → requireLogin → logRequests → listTickets
          (api)          (v1)
```

You can nest as deep as you like. Each level adds its prefix and its middleware.

---

## Adding middleware after the group exists

`Use` on a router attaches middleware to every route that router holds. This works on a group too:

```go
r := router.New()
admin := r.Group("/admin")
admin.Use(requireLogin)
```

This does the same thing as passing `requireLogin` to `Group`. `nil` is skipped here as well.

---

## What a group does when no route matches

Group middleware runs only after one of the group's routes matches the request. A request that falls under the prefix but matches none of the group's routes goes to the router's not-found handler. The group's middleware does not run for it.

```go
r := router.New()
admin := r.Group("/admin", requireLogin)
admin.HandleFunc("/users", listUsers).Methods(http.MethodGet)

// GET /admin/users    → requireLogin runs, then listUsers
// GET /admin/unknown  → not-found handler, requireLogin does not run
```

See [CORS and roots](./cors.md) for how to set the not-found and method-not-allowed handlers.

---

## Groups and CORS

A group has no CORS policy of its own. CORS is set once on the root router with `SetCORS`, and it covers every group under it. See [CORS and roots](./cors.md).

---

## Subrouter

`Group` is the router's version of gorilla/mux's `PathPrefix(...).Subrouter()`. If you build a route by hand, `Route.Subrouter()` gives you the sub-router under that route:

```go
r := router.New()
sub := r.PathPrefix("/files").Subrouter()
sub.HandleFunc("/{name}", download).Methods(http.MethodGet)
```

It returns a `*Router`, like `Group`, but takes no middleware argument. Add middleware with `sub.Use(...)`. It also has no CORS policy of its own.
