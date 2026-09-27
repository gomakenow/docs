---
title: Getting started
description: Six steps to gate your first route with role-based access control.
---

# Getting started

<Badge type="tip" text="Requires migration" />

Most apps start with a boolean `is_admin` flag. That breaks the moment you need different access levels: support views tickets but cannot delete them, billing refunds invoices but cannot see customer data, a nightly job closes stale tickets and nothing else. A single flag cannot express those distinctions.

The ACL package replaces that flag with three ideas:

- **Permissions** — Named actions like `"ticket.view"` or `"invoice.refund"`. You define them in `permission.go`.
- **Roles** — Reusable bundles of permissions. You create them, assign them to people, and the package checks membership.
- **`engine.Can`** — Returns yes or no: does this person have this permission?

In six steps, you gate your first route.

---

## Step 1 — Publish the migration

The package ships with SQL that creates five tables. Apply it:

```bash
make -C backend/acl migrate-publish
make migrate-up
```

This creates `permissions`, `roles`, `role_permissions`, `subject_roles`, and `subject_permissions`. It also inserts one built-in role named `superadmin` (explained later on the [Superadmin](./superadmin.md) page).

---

## Step 2 — Name a permission

A permission is lowercase with dots: `ticket.view`, `invoice.refund`. The Go constant is CamelCase: `TicketView`, `InvoiceRefund`.

Add one with:

```bash
make -C backend/acl add-permission ticket.view "View one support ticket."
```

This rewrites `permission.go`:

```go
const TicketView = "ticket.view"

func Catalog() []PermissionSpec {
    return []PermissionSpec{
        {Name: TicketView, Description: "View one support ticket."},
    }
}
```

Use the constant in code so typos fail at compile time. You can edit `permission.go` by hand instead of using Make — just keep the constant and `Catalog()` entry in sync.

---

## Step 3 — Implement the Subject interface

The package never opens your users table. When you assign a role, it stores the user's ID and type. Your user model must provide both via the `Subject` interface.

In `models/user.go` (where your `User` type is defined):

```go
func (u *User) GetID() string {
    return strconv.FormatInt(u.ID, 10)
}

func (u *User) GetType() string {
    return acl.SubjectUser
}
```

`GetID` returns the user's primary key as text. `GetType` returns `acl.SubjectUser` (the string `"user"`). Together, they identify the user as the pair `("42", "user")`. The type prevents ID collisions with machines or other actors.

---

## Step 4 — Create the engine

Call `acl.New` once from `main()`:

```go
engine, err := acl.New(ctx, db, &acl.Config{
    TenantMode: acl.SingleTenant,
}, func(r *http.Request) acl.Subject {
    user, ok := auth.UserFromContext(r.Context())
    if !ok || user == nil {
        return nil
    }
    return user
})

if err != nil {
    log.Fatalf("acl engine: %v", err)
}
```

The engine takes:
- A database connection
- Config (SingleTenant for one company, MultiTenant for multiple)
- A function that reads the logged-in user from the request context

Your auth middleware must run first and put the user on the context; the engine reads it from there.

At startup, the engine syncs `permission.go` into the database: inserts new permissions, updates descriptions, and deletes removed ones.

---

## Step 5 — Create a role and test

Create a role, add the permission, assign it to a user, and call `engine.Can`:

```go
role, err := engine.CreateRole(ctx, acl.NoTenant, "support", nil)
err = engine.SetRolePermissions(ctx, role.ID, []string{acl.TicketView})
err = engine.AssignRole(ctx, user, role.ID, acl.NoTenant)

ok, err := engine.Can(ctx, user, acl.TicketView, acl.NoTenant)
// ok is true

ok, err = engine.Can(ctx, user, acl.InvoiceRefund, acl.NoTenant)
// ok is false
```

This shows the flow: create role → add permissions → assign to user → check with `engine.Can`.

---

## Step 6 — Gate the route

Bind the engine to your router and use `RequirePermission` to declare what permission is required:

```go
r := engine.Bind(mux.NewRouter())
r.Use(authenticate)  // your auth middleware

r.HandleFunc("/tickets/{id}", showTicket).
    Methods("GET").
    RequirePermission(acl.TicketView)
```

When a request arrives:
1. `authenticate` runs first and puts the user on the context
2. `RequirePermission` reads that user and calls `engine.Can`
3. If the check passes, `showTicket` runs
4. If it fails, the request returns 403 and the handler never runs

**Important:** Put `RequirePermission` after `Methods`. At that point, the handler is registered and `RequirePermission` can wrap it. Earlier, there is nothing to wrap.

::: warning
Put `RequirePermission` after `Methods`. At that point, the handler is registered and `RequirePermission` can wrap it. If you call it earlier, the handler doesn't exist yet and the check is never installed.
:::

---

## Response codes

- **401 Unauthorized** — No user on the context (authentication failed)
- **403 Forbidden** — User is logged in but lacks the permission
- **200 OK** — User has the permission; handler runs normally

---

## Next steps

| Page | For |
|---|---|
| [Roles and grants](./roles.md) | Multiple permissions per role, one-off grants, reading roles for admin screens |
| [Displaying access](./screens.md) | Loading and displaying permissions, pagination, custom SQL |
| [People and machines](./subjects.md) | API keys, cron jobs, machines that need permissions |
| [Gating routes](./http.md) | Multiple permissions per route, checks inside handlers, middleware patterns |
| [Superadmin](./superadmin.md) | The built-in bypass role |
| [Cache](./cache.md) | How permissions are cached, when to disable it |
| [Reference](./reference.md) | Complete API reference |
| [Testing](./testing.md) | Writing tests with real engines |
