---
title: Testing
description: Running the router package tests, and testing your own routes with httptest.
---

# Testing

There are two layers, the same as the other packages.

| Layer | Database | When to use it |
|---|---|---|
| Package tests (`backend/router`) | None | Only when you are changing the package itself |
| Your route tests | Whatever your handlers need | Every test that checks a route, its middleware, or its order |

---

## Running the package tests

The package tests need no database and no `.env` file:

```bash
make -C backend/router test-router
make -C backend/router test-router TestName   # one test
```

They cover:

- Step order and middleware order
- `Use` and `With` together, and `Use` before or after the handler
- CORS: preflight, allowed origin, rejected origin, rejected header
- Credentials and the origin validator
- `RateLimit`: the limit, the window, and the per-client count
- Bad arguments panicking at startup
- Not-found and method-not-allowed handlers

---

## Testing your own routes

Build the router the same way `main` does, then send requests with `httptest`. Check the status code, not only the handler's output, so middleware and steps are covered.

```go
func TestTicketsRequireLogin(t *testing.T) {
    r := router.New()
    api := r.Group("/api", requireLogin)
    api.HandleFunc("/tickets", listTickets).Methods(http.MethodGet)

    rec := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/api/tickets", nil)
    r.ServeHTTP(rec, req)

    require.Equal(t, http.StatusUnauthorized, rec.Code)
}
```

Call `ServeHTTP` on the root router, not on the handler. Calling the handler directly skips every `Use` middleware and every `With` step.

::: tip
A handler test can call the handler directly to check its logic. A route test is needed to prove the route is gated. Keep both.
:::

---

## Steps in tests

A step runs at startup, so a test that registers a route runs its steps. To test a step on its own, call it with a route you built:

```go
r := router.New()
rt := r.HandleFunc("/x", h).Methods(http.MethodGet)
guard.RequirePermission("ticket.list")(rt.Route)
```

Use that only when you need to check the step by itself. Most checks are easier through `ServeHTTP`.
