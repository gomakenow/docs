---
title: Gating routes
description: Protect gorilla/mux routes with RequirePermission middleware.
---

# Gating routes

The ACL engine integrates with gorilla/mux routers to protect HTTP routes. Instead of checking permissions manually in every handler, you declare the permission required on the route itself. The middleware handles the check, and the handler only runs when the user passes.

The setup is simple: attach the engine to your router with `Bind`, add your authentication middleware, then chain `RequirePermission` on each route.

---

## Attaching the engine to the router

`engine.Bind` wraps your router and enables the `RequirePermission` method on all routes.

```go
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: func(r *http.Request) acl.Subject {
        // Your auth middleware stored the user on the context
        user, ok := auth.UserFromContext(r.Context())
        if !ok {
            return nil
        }
        return user
    },
})

router := mux.NewRouter()
router = engine.Bind(router)  // Attach the engine
```

Call `Bind` once at startup on your root router. The engine is now attached to all routes and subrouters.

---

## Adding your authentication middleware

Your authentication middleware must run before ACL checks. It is responsible for:
- Parsing login credentials (session, token, etc.)
- Finding the user in your database
- Storing the user on the request context

The ACL engine will read the user from that context when it needs to check permissions.

```go
router.Use(authenticate)  // Your middleware, registered BEFORE routes

func authenticate(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Parse credentials, find user, etc.
        user := findUserFromSession(r)
        
        // Store the user on the context so ACL can access it
        r = r.WithContext(auth.ContextWithUser(r.Context(), user))
        
        next.ServeHTTP(w, r)
    })
}
```

The order matters: authentication middleware must run first. Without it, the user is not on the context and ACL checks will fail.

---

## Declaring permissions on routes

Chain `RequirePermission` after `Methods` on any route you want to protect.

```go
router.HandleFunc("/tickets", listTickets).
    Methods("GET").
    RequirePermission(acl.TicketList)

router.HandleFunc("/tickets/{id}", showTicket).
    Methods("GET").
    RequirePermission(acl.TicketView)

router.HandleFunc("/tickets/{id}/reply", replyToTicket).
    Methods("POST").
    RequirePermission(acl.TicketReply)

router.HandleFunc("/tickets/{id}", deleteTicket).
    Methods("DELETE").
    RequirePermission(acl.TicketDelete)
```

When a request comes in, the middleware checks the permission before calling the handler. If the user has the permission, the handler runs. If not, the request returns an error response and the handler does not run.

::: warning
Keep `RequirePermission` after `Methods`. That is when the handler is already on the route, so the check can wrap it. If you call it before `Methods`, there is nothing to wrap, and the route is left open.
:::

### Subrouters keep the engine

If you organize routes into subrouters with `PathPrefix`, those subrouters inherit the engine from the parent router. `RequirePermission` works on all of them.

```go
router := mux.NewRouter()
router = engine.Bind(router)

admin := router.PathPrefix("/admin").Subrouter()
admin.Use(authenticate)

// RequirePermission works on the subrouter
admin.HandleFunc("/roles", listRoles).
    Methods("GET").
    RequirePermission(acl.RoleList)
```

---

## What happens when the check fails

The middleware handles four cases:

| Situation | Status | Response body |
|---|---|---|
| No user on the context (authentication failed) | 401 | `unauthorized` |
| User is logged in but lacks the permission | 403 | `forbidden` |
| The engine is `nil` or not bound | 500 | `acl engine is not configured` |
| The permission check returns an error | 500 | `internal error` |

When the check fails, the handler does not run. The response is returned immediately.

Errors from the database or permission lookup (like `ErrRoleNotFound`) return a 500. These indicate a problem with your data or configuration, not a user permission issue. Do not try to turn these into 404s on the HTTP layer — fix the data issue instead.

---

## Multiple permissions on one route

Some routes need more than one permission. For example, a handler might need to both view and edit tickets. Use `RequirePermissions` (plural) to check multiple names.

**All of these permissions are required:**

```go
router.HandleFunc("/tickets/{id}", editTicket).
    Methods("POST").
    RequirePermissions([]string{acl.TicketView, acl.TicketEdit})
```

The user must have every permission in the list. If they have `ticket.view` but not `ticket.edit`, they get a 403.

**Any of these permissions is enough:**

If the user only needs one of several permissions (e.g., "can edit as an owner OR edit as a moderator"), use a different approach. This package does not provide a syntax for "any of these." Instead, define a single permission that represents that choice:

```go
// In permission.go, define one permission that means either:
const TicketEdit = "ticket.edit"

// Then assign that permission to both the "owner" and "moderator" roles
// Now both roles have ticket.edit, and a single RequirePermission call works
```

---

## Checking permissions inside handlers

Sometimes a button or feature inside the handler needs a different permission than the route itself. For example, the handler for GET /tickets requires `ticket.view`, but a refund button inside that page might need `invoice.refund`.

Load the user from the context and call `engine.Can` directly:

```go
func showTicket(w http.ResponseWriter, r *http.Request) {
    // The route RequirePermission already checked ticket.view
    // This is for an extra check inside the handler
    
    user, ok := auth.UserFromContext(r.Context())
    if !ok {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }
    
    allowed, err := engine.Can(r.Context(), user, acl.InvoiceRefund, acl.NoTenant)
    if err != nil {
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    
    if !allowed {
        http.Error(w, "forbidden", http.StatusForbidden)
        return
    }
    
    // Now the user has invoice.refund; show the refund button
}
```

Do not call `RequirePermission` again inside a handler. Use `engine.Can` for a manual check.

### Checking multiple permissions at once

**`engine.CanAll`** returns true if the user has every permission in a list.

```go
allowed, err := engine.CanAll(r.Context(), user, []string{
    acl.TicketView,
    acl.TicketEdit,
}, acl.NoTenant)
```

The user must have all of them.

**`engine.CanAny`** returns true if the user has any permission in a list.

```go
allowed, err := engine.CanAny(r.Context(), user, []string{
    acl.TicketEdit,
    acl.TicketModerate,
}, acl.NoTenant)
```

The user needs at least one. Use this when multiple roles can perform the same action.

Both `CanAll` and `CanAny` load the user's permissions once and check all names against that single set. They do not run separate queries for each permission.

---

## Router-wide permissions

Sometimes every route on a router requires the same permission. Instead of chaining `RequirePermission` on each route, you can attach it once as middleware. The middleware runs for every request and checks the permission before routing to any handler.

### Using router middleware

When you register middleware with `router.Use()`, it wraps every route on that router and its subrouters. Add authentication first, then the permission check.

```go
adminRouter := mux.NewRouter()
adminRouter = engine.Bind(adminRouter)

// Middleware runs in order: authenticate first, then check permission
adminRouter.Use(authenticate)
adminRouter.Use(acl.RequirePermission(engine, acl.AdminAccess))

// All routes below require admin.access, no need to repeat it
adminRouter.HandleFunc("/users", listUsers).Methods("GET")
adminRouter.HandleFunc("/roles", listRoles).Methods("GET")
adminRouter.HandleFunc("/settings", editSettings).Methods("POST")
```

When a request comes in, the middleware stack runs top to bottom:
1. `authenticate` middleware reads the user and puts them on the context
2. `acl.RequirePermission` middleware reads that user and checks `admin.access`
3. If the check passes, the handler runs; if it fails, the request returns 403 and the handler never runs

### How RequirePermission works under the hood

`acl.RequirePermission` is a middleware factory. It takes an engine and a permission name, and returns a standard Go middleware function:

```go
type Middleware func(http.Handler) http.Handler

middleware := acl.RequirePermission(engine, acl.AdminAccess)
```

The returned middleware wraps a handler:

```go
wrappedHandler := middleware(originalHandler)
```

When a request comes in:
1. The middleware calls `engine.LookupSubject(r.Context())` to read the user stored by your auth middleware
2. It calls `engine.Can(r.Context(), subject, permission, tenant)` to check the permission
3. If the check passes, it calls `next.ServeHTTP(w, r)` to run the original handler
4. If it fails, it returns 403 and the original handler is never called

This is true whether you use `RequirePermission` as router middleware with `Use()` or on an individual route — the permission check happens before the handler, and the handler only runs if the permission passes.

### Doing it manually without RequirePermission

If you need custom logic beyond a simple permission check, you can write middleware yourself. Here is a basic pattern:

```go
func RequireCustomPermission(engine *acl.Engine, perm string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Read the user from context (your auth middleware put it there)
            user, ok := auth.UserFromContext(r.Context())
            if !ok {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }
            
            // Check the permission
            allowed, err := engine.Can(r.Context(), user, perm, acl.NoTenant)
            if err != nil {
                http.Error(w, "internal error", http.StatusInternalServerError)
                return
            }
            
            if !allowed {
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }
            
            // Permission passed, call the next handler
            next.ServeHTTP(w, r)
        })
    }
}

// Use it the same way
adminRouter.Use(RequireCustomPermission(engine, acl.AdminAccess))
```

The pattern is always the same:
1. Check the user is on the context
2. Check the permission
3. Return an error if either fails
4. Call `next.ServeHTTP(w, r)` to let the handler run

You can extend this to check multiple permissions, log denied requests, add custom headers, or run any other logic before the handler.

### Helper functions for subrouters

The package provides two shortcuts for common patterns:

**`acl.Gate`** adds one permission check to a subrouter:

```go
admin := router.PathPrefix("/admin").Subrouter()
acl.Gate(admin, engine, acl.AdminAccess)

admin.HandleFunc("/users", listUsers).Methods("GET")
admin.HandleFunc("/roles", listRoles).Methods("GET")
```

It is equivalent to calling `admin.Use(acl.RequirePermission(engine, acl.AdminAccess))`.

**`acl.Group`** creates a subrouter at a path prefix and attaches the permission in one call:

```go
acl.Group(router, engine, "/admin", acl.AdminAccess)
```

Both are shortcuts. For most projects, declaring permissions on individual routes with `RequirePermission` is clearer and easier to maintain. Use router middleware when every single route on a router truly needs the same permission, which is rare.

---
