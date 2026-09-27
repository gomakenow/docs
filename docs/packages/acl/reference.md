---
title: Reference
description: Complete API reference for the ACL package.
---

# Reference

This page contains the complete API reference: every type, method, configuration field, error, and database table.

For explanations and usage patterns, see the other pages in this documentation. This page is for looking up exact signatures and behavior.

---

## Creating an engine

```go
engine, err := acl.New(ctx, db, &acl.Config{
    TenantMode:          acl.SingleTenant,
    DisableCache:        false,
    Cache:               nil,
    SuperadminEmailOrID: "",
})
```

`acl.New` performs four steps:
1. Validates that `db` is not nil; returns `ErrNilDB` if missing
2. Applies configuration defaults
3. Syncs the permission catalog from `permission.go` — inserts new permissions, updates descriptions, deletes removed names and cascades to pivot rows
4. If `SuperadminEmailOrID` is set to a user ID (not an email), assigns the built-in superadmin role to that ID

Returns an error if the catalog sync fails.

---

## Configuration

```go
type Config struct {
    TenantMode          TenantMode  // SingleTenant (default) or MultiTenant
    DisableCache        bool        // false by default; set true to skip in-memory cache
    Cache               Cache       // nil by default; set to share cache across processes
    SuperadminEmailOrID string      // empty by default; a user id or email
}
```

### TenantMode

- `acl.SingleTenant` (default) — All tenant arguments become `acl.NoTenant` (`"default"`)
- `acl.MultiTenant` — Tenant arguments are used as-is; blank id becomes `"default"`

Never store `NULL` in the `tenant_id` column. The composite primary keys on pivot tables rely on `tenant_id` being a non-null string.

### DisableCache

When `true`, every call to `Can`, `CanAny`, `CanAll`, `CanGlobal`, `PermissionsFor`, and `IsSuperadmin` reads directly from the database. The `Cache` field is ignored.

### Cache

A custom cache implementation for sharing permissions across multiple processes. See the [Cache](./cache.md) page for details.

### SuperadminEmailOrID

- Empty string (default) — No automatic superadmin; use `engine.AssignSuperadmin` in code
- A user ID string (e.g., `"42"`) — Assigns the superadmin role to that ID at startup
- An email (e.g., `"owner@example.com"`) — Matches via `GetEmail()` on every check

---

## Subject interface

Every subject must implement:

```go
type Subject interface {
    GetID() string       // Unique identifier, never empty
    GetType() string     // acl.SubjectUser or acl.SubjectMachine, never empty
}
```

Optionally implement for email-based superadmin:

```go
type EmailSubject interface {
    GetEmail() string
}
```

A convenience struct for machines and tests:

```go
type Actor struct {
    ID   string
    Type string
}
```

### Subject constants

```go
const (
    SubjectUser    = "user"
    SubjectMachine = "machine"
    NoTenant       = "default"
)

const (
    RoleSuperadmin   = "superadmin"
    RoleSuperadminID = "11111111-1111-1111-1111-111111111111"
)
```

---

## Permission catalog

### Methods

| Method | Signature | Returns |
|---|---|---|
| `Catalog()` | `func() []PermissionSpec` | The permission definitions from `permission.go` |
| `Permissions(ctx)` | `func(context.Context) ([]PermissionSpec, error)` | Current permissions in the database |
| `Register(ctx, specs...)` | `func(context.Context, ...PermissionSpec) error` | Upsert permissions; used mainly in tests |

### PermissionSpec

```go
type PermissionSpec struct {
    Name        string          // Required; dot-separated (e.g., "ticket.view")
    Description string          // Required; max 512 characters
    Meta        json.RawMessage // Optional; custom JSON data for your UI
}
```

`NormalizePermissionDescription(desc string) (string, error)` validates and trims a description.

---

## Permission checks

### Can

```go
allowed, err := engine.Can(ctx, subject, permission, tenantID)
```

Returns `true` if:
- Subject is a superadmin, OR
- The permission name is in the subject's resolved set

Returns errors: `ErrNilEngine`, `ErrEmptySubject`, `ErrEmptySubjectType`, `ErrEmptyPermission`, database errors.

### CanAny

```go
allowed, err := engine.CanAny(ctx, subject, permissions, tenantID)
```

Returns `true` if the subject has **any** permission in the slice. Empty slice returns `false`. Loads the resolved set once; checks in memory.

### CanAll

```go
allowed, err := engine.CanAll(ctx, subject, permissions, tenantID)
```

Returns `true` if the subject has **every** permission in the slice. Empty slice returns `true`. Loads the resolved set once; checks in memory.

### CanGlobal

```go
allowed, err := engine.CanGlobal(ctx, subject, permission)
```

Equivalent to `Can(ctx, subject, permission, acl.NoTenant)`. Use for platform-level checks.

### PermissionsFor

```go
permissions, err := engine.PermissionsFor(ctx, subject, tenantID)
```

Returns the subject's complete resolved set: every permission from roles and direct grants, deduplicated. Order is not guaranteed. Returns empty slice (not nil) when the subject has no permissions.

Returns errors: `ErrNilEngine`, `ErrEmptySubject`, `ErrEmptySubjectType`, database errors.

### IsSuperadmin

```go
is_admin, err := engine.IsSuperadmin(ctx, subject)
```

Returns `true` if:
- Subject is `acl.SubjectUser` AND (ID or email matches `SuperadminEmailOrID` OR subject holds the built-in superadmin role)

User only. Returns false for machines. Returns errors: `ErrNilEngine`, `ErrEmptySubject`, database errors.

---

## Roles

### CreateRole

```go
role, err := engine.CreateRole(ctx, tenantID, name, meta)
```

Inserts a new role.

- Returns `ErrRoleExists` if the name already exists in the tenant
- Returns `ErrProtectedRole` if `name` is `"superadmin"` and `tenantID` is `acl.NoTenant`
- `meta` is optional; pass `nil` or a `json.RawMessage` with custom data
- Returns the created role with ID, Name, Metadata, and empty Permissions

### DeleteRole

```go
err := engine.DeleteRole(ctx, roleID)
```

Deletes the role and cascades to all pivot rows.

- Returns `ErrRoleNotFound` if the role does not exist
- Returns `ErrProtectedRole` if trying to delete the built-in superadmin role
- Does not check whether users still hold the role; pivot rows are deleted

### GetRole

```go
role, err := engine.GetRole(ctx, roleID)
```

Returns one role with its permissions.

- Returns `ErrRoleNotFound` if the role does not exist
- Returns `ErrEmptyRoleID` if roleID is blank

### Roles

```go
roles, err := engine.Roles(ctx, tenantID)
```

Returns all roles in the tenant, ordered by name. Permissions are not loaded. Use `RolesWithPermissions` to load them.

### RolesWithPermissions

```go
roles, err := engine.RolesWithPermissions(ctx, tenantID)
```

Same as `Roles`, but each role's Permissions field is populated.

### RolesFor

```go
roles, err := engine.RolesFor(ctx, subject, tenantID)
```

Returns roles assigned to the subject in the tenant, ordered by name. Permissions are not loaded.

### RoleNames

```go
names, err := engine.RoleNames(ctx, subject, tenantID)
```

Returns just the names from `RolesFor`.

### HasRole

```go
has_it, err := engine.HasRole(ctx, subject, tenantID, roleName)
```

Returns `true` if the subject is assigned the role. For `"superadmin"`, delegates to `IsSuperadmin`.

---

## Role permissions

### SetRolePermissions

```go
err := engine.SetRolePermissions(ctx, roleID, permissionNames)
```

Replaces the entire permission list on the role.

- Returns `ErrPermissionNotFound` if any name is not in the catalog
- Returns `ErrSuperadminBypassesPermissions` if the role is the built-in superadmin
- Invalidates cache for every subject holding this role

### AddPermissionToRole

```go
err := engine.AddPermissionToRole(ctx, roleID, permissionName)
```

Adds one permission to the role.

- Calling twice with the same name is safe (on-conflict do nothing)
- Same error returns as `SetRolePermissions`
- Invalidates cache for every subject holding this role

### RemovePermissionFromRole

```go
err := engine.RemovePermissionFromRole(ctx, roleID, permissionName)
```

Removes one permission from the role.

- Safe to call even if the role does not have the permission
- Returns same errors as `SetRolePermissions`
- Invalidates cache for every subject holding this role

---

## Role assignments

### AssignRole

```go
err := engine.AssignRole(ctx, subject, roleID, tenantID)
```

Links a subject to a role in a tenant.

- Calling twice for the same subject/role/tenant is safe (on-conflict do nothing)
- Returns `ErrRoleTenantMismatch` if the role's tenant does not match the tenant argument
- Returns `ErrSuperadminRequiresUser` if trying to assign the superadmin role to a machine
- Invalidates the subject's cache entry

### AssignRoleByName

```go
err := engine.AssignRoleByName(ctx, subject, roleName, tenantID)
```

Looks up the role by name in the tenant, then assigns it.

- Returns `ErrRoleNotFound` if no role with that name exists
- Calling twice for the same subject/name/tenant is safe
- Invalidates the subject's cache entry

### RevokeRole

```go
err := engine.RevokeRole(ctx, subject, roleID, tenantID)
```

Removes the link between subject and role.

- Safe to call even if the subject did not have the role
- Does not check whether the role exists; uses only the ID
- Invalidates the subject's cache entry

### AssignSuperadmin

```go
err := engine.AssignSuperadmin(ctx, subject)
```

Assigns the built-in superadmin role at `acl.NoTenant`.

- User only; returns `ErrSuperadminRequiresUser` for machines
- Safe to call multiple times
- Invalidates cache

### RevokeSuperadmin

```go
err := engine.RevokeSuperadmin(ctx, subject)
```

Removes the superadmin role assignment at `acl.NoTenant`.

- Safe to call even if subject did not have the role
- Invalidates cache

---

## Direct grants

### Grant

```go
err := engine.Grant(ctx, subject, permission, tenantID)
```

Writes a direct permission grant to one subject.

- User only; returns `ErrDirectGrantsNotAllowedForSubjectType` for machines
- Returns `ErrPermissionNotFound` if the name is not in the catalog
- For superadmins, succeeds but writes nothing (no-op)
- Invalidates the subject's cache entry

### Revoke

```go
err := engine.Revoke(ctx, subject, permission, tenantID)
```

Removes a direct grant.

- Safe to call even if the subject does not have the grant
- For superadmins, succeeds but does nothing (no-op)
- Invalidates the subject's cache entry

---

## Context helpers

```go
// Store and retrieve the logged-in subject
ctx = acl.ContextWithSubject(ctx, subject)
subject, ok := acl.SubjectFromContext(ctx)

// Store and retrieve the tenant ID
ctx = acl.ContextWithTenant(ctx, tenantID)
tenantID, ok := acl.TenantFromContext(ctx)

// Internal: used by RequirePermission to read what your SubjectFunc stored
subject, ok := engine.LookupSubject(ctx)
tenantID := engine.LookupTenant(ctx)  // Returns acl.NoTenant if not set
```

---

## HTTP route gating

```go
// Bind the engine to a router
r := engine.Bind(mux.NewRouter())

// Require permission on a route (call after Methods)
r.HandleFunc("/tickets", list).Methods("GET").RequirePermission(acl.TicketList)

// Require permission on all routes in a router
r.Use(acl.RequirePermission(engine, acl.TicketView))

// Subrouter shortcuts (less common; prefer Bind + per-route RequirePermission)
sub := acl.Group(parent, engine, "/admin", acl.AdminAccess)
sub := acl.Gate(parent, engine, acl.AdminAccess)
```

---

## Cache interface

```go
type Cache interface {
    Get(key string) ([]string, bool)     // Read; ok=true if found
    Set(key string, perms []string)      // Write
    Invalidate(key string)               // Delete
}

// Built-in memory cache
cache := acl.NewMemoryCache()
```

### Cache keys

- `subject_id:subject_type:tenant_id` — The resolved permission set
- `superadmin:<subject_id>` — Marker for superadmin role assignment at `acl.NoTenant`

See the [Cache](./cache.md) page for details.

---

## Sentinel errors

| Error | Context | Typical HTTP status |
|---|---|---|
| `ErrNilDB` | `New` called with nil `db` | 500 |
| `ErrNilEngine` | Any method on nil `*Engine` | 500 |
| `ErrEmptySubject` | Nil subject or `GetID()` returns blank | 400 |
| `ErrEmptySubjectType` | `GetType()` returns blank | 400 |
| `ErrEmptyPermission` | Blank permission name passed to `Can` or `Grant` | 400 |
| `ErrEmptyRoleName` | Blank role name in `CreateRole` | 400 |
| `ErrEmptyRoleID` | Blank role ID in `GetRole` or similar | 400 |
| `ErrPermissionNotFound` | Name not in the catalog | 404 |
| `ErrRoleNotFound` | Role ID does not exist | 404 |
| `ErrRoleExists` | Duplicate `(tenant, name)` in `CreateRole` | 409 |
| `ErrRoleTenantMismatch` | Assigning a role whose tenant does not match the call | 400 |
| `ErrDirectGrantsNotAllowedForSubjectType` | `Grant` called on a machine | 400 |
| `ErrSuperadminRequiresUser` | Superadmin role assigned to a machine | 400 |
| `ErrProtectedRole` | Deleting superadmin or creating `"superadmin"` in `acl.NoTenant` | 403 |
| `ErrSuperadminBypassesPermissions` | Modifying permissions on the superadmin role | 403 |

`RequirePermission` does not use this table; it returns only 401 (unauthorized), 403 (forbidden), and 500 (internal error). Map these errors in handlers that create roles and write grants.

---

## Database tables

The migration creates five tables. Cascade foreign keys delete pivot rows when roles or permissions are deleted. No foreign key to your users or organizations.

| Table | Primary key | Hot lookup index |
|---|---|---|
| `permissions` | `id uuid` | `(name)` unique |
| `roles` | `id uuid` | `(tenant_id, name)` unique |
| `role_permissions` | `(role_id, permission_id)` | — |
| `subject_roles` | `(subject_id, subject_type, role_id, tenant_id)` | `(subject_id, subject_type, tenant_id)` |
| `subject_permissions` | `(subject_id, subject_type, permission_id, tenant_id)` | `(subject_id, subject_type, tenant_id)` |

All string columns (`tenant_id`, `subject_id`, `subject_type`) are non-null `varchar`. Never store `NULL` in these columns — the composite primary keys rely on them.

### Migrations

Permissions are synced at startup by `acl.New`. To add, change, or remove a permission, edit `permission.go` and restart the application. New permissions are inserted, changed descriptions are updated, and removed permissions are deleted (cascading to pivot rows).

For direct SQL access to these tables (e.g., building paginated admin screens), see the [Displaying access](./screens.md) page.
