---
title: Chaining
description: How Use and With attach middleware and steps to a route, and in what order they run.
---

# Chaining

When you register a route, you get a route back. Every call on that route gives you the same route again, so you can keep adding to it on the next line:

```go
r := router.New()
r.HandleFunc("/tickets", listTickets).
    Methods(http.MethodGet).
    Use(requireLogin).
    With(requirePermission)
```

`HandleFunc` and `Methods` are the normal gorilla/mux calls. `Use` and `With` are the two the router adds. Both attach something to the route, but they do different jobs.

| Call | You pass it | What it is for |
|---|---|---|
| `Use` | A `Middleware` | Code that runs on **every request** before your handler |
| `With` | A `Step` | Code that runs **once**, when the route is declared |

---

## Use: code that runs on every request

A middleware is a normal Go function that takes a handler and returns a handler:

```go
type Middleware func(http.Handler) http.Handler
```

`Use` wraps your handler with it. When a request comes in, the middleware runs first. It decides whether to call your handler or stop.

```go
func requireLogin(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !loggedIn(r) {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        next.ServeHTTP(w, r)
    })
}

r := router.New()
r.HandleFunc("/export", export).
    Methods(http.MethodGet).
    Use(requireLogin)
```

You can pass several middleware to one `Use`. The first one you pass runs first:

```go
Use(requireLogin, router.Throttle(1, 5, nil))
// A request goes through requireLogin, then Throttle, then export.
```

You can also call `Use` more than once. Each call adds to the list, in the order you wrote the calls.

### Where you put `Use`

`Use` does not have to come after the handler is set. These two routes behave the same:

```go
r := router.New()
r.HandleFunc("/export", export).Use(requireLogin)

r.NewRoute().Path("/export").Use(requireLogin).HandlerFunc(export)
```

The router remembers the middleware and wraps the handler as soon as the handler exists.

### `nil` is skipped

If you pass a `nil` middleware, the router ignores it. No error, no panic.

---

## With: code that runs once

A step is a function that receives the route itself:

```go
type Step func(*mux.Route)
```

The router calls your step **one time**, right when the route is declared, while the server is starting. It does not run for each request.

That one call gives the step two things it can do:

- **Look at the route.** The `*mux.Route` knows its path and its methods. A step can read them and do something with them, such as save them in a list.
- **Wrap the handler.** A step can replace the route's handler with a new one that does something before calling the old one. After that, the new handler runs on every request.

Here is a step that does both. It prints the route's path once at startup, and it wraps the handler with a check that runs on each request:

```go
func requirePermission(rt *mux.Route) {
    path, _ := rt.GetPathTemplate() // runs once, at startup
    log.Println("protecting", path)

    next := rt.GetHandler()
    rt.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !allowed(r) { // runs on every request
            http.Error(w, "forbidden", http.StatusForbidden)
            return
        }
        next.ServeHTTP(w, r)
    }))
}

r := router.New()
r.HandleFunc("/tickets", listTickets).
    Methods(http.MethodGet).
    With(requirePermission)
```

Most steps in a real app come from a function that builds the step for you, like `guard.RequirePermission("ticket.list")`. It is the same idea: the function returns a `Step`.

`With` returns the route, so you can keep chaining after it. A `nil` step is skipped, the same as `nil` in `Use`.

---

## Use and With together

You can put both on one route. The rule is simple: **`Use` middleware is always on the outside**, and steps are on the inside, next to your handler.

```go
r := router.New()
r.HandleFunc("/tickets", listTickets).
    Methods(http.MethodGet).
    Use(requireLogin).
    With(requirePermission)
```

The request travels like this:

```
request → requireLogin → requirePermission → listTickets
```

If `requireLogin` stops the request, `requirePermission` never runs.

The order you write `Use` and `With` in the chain does not change this. Writing `With` first and `Use` after gives the same result. The router keeps the two lists apart and puts them together in the same way every time:

1. Start with your handler.
2. Run each step on it, one after the other. A step that wraps the handler puts its wrapper around whatever is there.
3. Wrap the result with the `Use` middleware, the first one outermost.

---

## Several steps in one With

Pass more than one step to `With`, or call `With` more than once. The router calls them at startup in the order you wrote them.

```go
r := router.New()
r.HandleFunc("/tickets/{id}/reply", reply).
    Methods(http.MethodPost).
    With(stepA, stepB)
```

At startup, `stepA` runs first and `stepB` runs second.

At request time, a step that wraps the handler goes around everything the earlier steps built. So if both steps wrap the handler, the wrapper from `stepB` is outside the wrapper from `stepA`, and a request meets `stepB`'s check first:

```
request → stepB's wrapper → stepA's wrapper → reply
```

A step that only reads the route adds no wrapper, so it does not appear in that line.

---

## Handler and HandlerFunc

`Handler` and `HandlerFunc` set the handler on a route you built piece by piece. They work like `Handle` and `HandleFunc` on the router, and the `Use` middleware you already added is applied when the handler is set.

```go
r := router.New()
r.NewRoute().
    Path("/health").
    Methods(http.MethodGet).
    HandlerFunc(health)
```

---

## Summary

| | `Use` | `With` |
|---|---|---|
| You pass | `func(http.Handler) http.Handler` | `func(*mux.Route)` |
| Runs | On every request | Once, at startup |
| Can read the route's path and methods | No | Yes |
| Position around the handler | Outside | Inside |
| Order | First one passed is outermost | Called in the order written; later wrapping steps sit outside earlier ones |
