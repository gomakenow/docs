---
title: Displaying access
description: Load roles and permissions for screens. Simple lists with the engine, and advanced tables with custom SQL.
---

# Displaying access

Admin screens need to show what permissions users have, what roles exist, and who holds which roles. The ACL engine provides simple methods for common cases. For more advanced scenarios — paginated tables, sorting, filtering, complex joins — you can query the database directly with SQL.

---

## Basic list loading with the engine

The engine provides methods to load permissions and roles for common UI patterns.

### A user's permissions and roles

When you want to show what one user can do, or what roles they belong to:

**`engine.PermissionsFor`** returns every permission a user has, from all their roles and all their direct grants, as a flat list.

```go
permissions, err := engine.PermissionsFor(ctx, user, acl.NoTenant)
if err != nil {
    return err
}
// permissions is []string{"ticket.view", "ticket.reply", "invoice.refund"}
```

Use this to show a user "here is what you are allowed to do" without distinguishing whether each permission came from a role or a direct grant. This is also the list to send to the browser to show or hide UI buttons: "if the user has invoice.refund, show the refund button".

**`engine.RolesFor`** returns the roles assigned to a user, in alphabetical order by name, without their permissions.

```go
roles, err := engine.RolesFor(ctx, user, acl.NoTenant)
if err != nil {
    return err
}
// roles is []*Role with ID, Name, Metadata, but Permissions field is empty
```

**`engine.RoleNames`** is a shortcut that returns just the names as strings.

```go
names, err := engine.RoleNames(ctx, user, acl.NoTenant)
if err != nil {
    return err
}
// names is []string{"support", "admin"}
```

If your screen needs to show *where* each permission came from — "they have ticket.view and ticket.reply from the support role, and invoice.refund from a direct grant" — you can load the roles and permissions separately and build a display that distinguishes them.

### All roles in the tenant

When you want to show every role and what it includes:

**`engine.Roles`** returns every role in the tenant, in alphabetical order, without loading the permissions on each. Use it when you need role names for a dropdown or a simple list.

```go
roles, err := engine.Roles(ctx, acl.NoTenant)
if err != nil {
    return err
}
```

**`engine.RolesWithPermissions`** returns the same roles with each one's permissions already loaded. Use it when you need to display a table showing all roles and what each includes.

```go
roles, err := engine.RolesWithPermissions(ctx, acl.NoTenant)
if err != nil {
    return err
}
// Each role struct has Permissions filled in
```

**`engine.GetRole`** returns a single role and its permissions by ID. Use it when someone opens a role to view or edit it.

```go
role, err := engine.GetRole(ctx, roleID)
if err != nil {
    return err
}
// role.Permissions contains the permission names
```

### The permission catalog

**`engine.Permissions`** returns the full list of permissions from your `permission.go` file, as they are stored in the database. Each entry has a name, description, and your optional metadata.

```go
catalog, err := engine.Permissions(ctx)
if err != nil {
    return err
}
// catalog is []PermissionSpec{Name, Description, Metadata, ...}
```

Use this for the checkbox or dropdown list when someone is editing a role — "here are all the permissions that exist; pick the ones you want this role to have". This is the catalog of what *is*, not what a specific user *has*.

---

## Advanced: custom SQL for tables

The engine's methods load data one query at a time. For advanced screens — paginated role tables, a user directory with their roles, a permissions matrix — you often need a single query that joins multiple tables, sorts, filters, and paginates.

The ACL package owns five tables. You can query them directly with SQL. Write your own queries that fit your screen's needs.

### ACL table schemas

**`permissions`** — The catalog of permission names from `permission.go`, synced at startup.

```
id          UUID (primary key)
name        VARCHAR (unique, e.g., "ticket.view")
description VARCHAR (max 512 chars)
metadata    JSONB (your custom data)
created_at  TIMESTAMP
```

**`roles`** — Role names and metadata, scoped to tenants.

```
id          UUID (primary key)
tenant_id   VARCHAR (e.g., "default" or org UUID)
name        VARCHAR (unique within tenant)
metadata    JSONB (your custom data)
created_at  TIMESTAMP
```

**`role_permissions`** — Links roles to the permissions they include. Many-to-many junction table.

```
role_id        UUID (foreign key to roles.id)
permission_id  UUID (foreign key to permissions.id)
created_at     TIMESTAMP
```

**`subject_roles`** — Links subjects (users or machines) to the roles they hold.

```
subject_id    VARCHAR (e.g., user ID "42")
subject_type  VARCHAR (e.g., "user" or "machine")
tenant_id     VARCHAR
role_id       UUID (foreign key to roles.id)
created_at    TIMESTAMP
```

**`subject_permissions`** — Direct grants: permissions assigned to one subject only.

```
subject_id    VARCHAR (e.g., user ID "42")
subject_type  VARCHAR (e.g., "user")
tenant_id     VARCHAR
permission_id UUID (foreign key to permissions.id)
created_at    TIMESTAMP
```

### Example: paginated list of roles with permission count

A common screen shows all roles with a count of how many permissions each has, sorted by name, with pagination.

```go
const query = `
SELECT 
    r.id,
    r.name,
    r.metadata,
    COUNT(rp.permission_id) as permission_count,
    r.created_at
FROM roles r
LEFT JOIN role_permissions rp ON r.id = rp.role_id
WHERE r.tenant_id = $1
GROUP BY r.id, r.name, r.metadata, r.created_at
ORDER BY r.name ASC
LIMIT $2 OFFSET $3
`

type RoleRow struct {
    ID               string          `db:"id"`
    Name             string          `db:"name"`
    Metadata         json.RawMessage `db:"metadata"`
    PermissionCount  int             `db:"permission_count"`
    CreatedAt        time.Time       `db:"created_at"`
}

var roles []RoleRow
err := db.SelectContext(ctx, &roles, query, tenantID, limit, offset)
```

### Example: users assigned to a specific role

Find all users (or machines) who hold a particular role.

```go
const query = `
SELECT DISTINCT
    sr.subject_id,
    sr.subject_type,
    sr.tenant_id,
    sr.created_at
FROM subject_roles sr
WHERE sr.role_id = $1
  AND sr.tenant_id = $2
ORDER BY sr.subject_id ASC
`

type SubjectRow struct {
    SubjectID   string    `db:"subject_id"`
    SubjectType string    `db:"subject_type"`
    TenantID    string    `db:"tenant_id"`
    CreatedAt   time.Time `db:"created_at"`
}

var subjects []SubjectRow
err := db.SelectContext(ctx, &subjects, query, roleID, tenantID)
```

### Example: search roles by name

Find roles that match a search term, paginated.

```go
const query = `
SELECT 
    r.id,
    r.name,
    r.metadata,
    r.created_at
FROM roles r
WHERE r.tenant_id = $1
  AND r.name ILIKE $2
ORDER BY r.name ASC
LIMIT $3 OFFSET $4
`

// Caller passes search string, we add wildcards
searchPattern := "%" + searchTerm + "%"
var roles []RoleRow
err := db.SelectContext(ctx, &roles, query, tenantID, searchPattern, limit, offset)
```

### Example: permissions a user has with their source

Show a user's permissions broken down by role assignment vs. direct grant.

```go
const query = `
-- Permissions from roles
SELECT DISTINCT
    p.id,
    p.name,
    p.description,
    'role' as source,
    r.name as role_name,
    r.id as role_id
FROM permissions p
JOIN role_permissions rp ON p.id = rp.permission_id
JOIN roles r ON rp.role_id = r.id
JOIN subject_roles sr ON r.id = sr.role_id
WHERE sr.subject_id = $1
  AND sr.subject_type = $2
  AND sr.tenant_id = $3

UNION ALL

-- Direct grants
SELECT
    p.id,
    p.name,
    p.description,
    'direct' as source,
    NULL::VARCHAR as role_name,
    NULL::UUID as role_id
FROM permissions p
JOIN subject_permissions sp ON p.id = sp.permission_id
WHERE sp.subject_id = $1
  AND sp.subject_type = $2
  AND sp.tenant_id = $3

ORDER BY name ASC
`

type PermissionWithSource struct {
    ID          string          `db:"id"`
    Name        string          `db:"name"`
    Description string          `db:"description"`
    Source      string          `db:"source"` // "role" or "direct"
    RoleName    *string         `db:"role_name"` // nil if source is "direct"
    RoleID      *string         `db:"role_id"`
}

var perms []PermissionWithSource
err := db.SelectContext(ctx, &perms, query, subjectID, subjectType, tenantID)
// Now you can display: "ticket.view (from support role), invoice.refund (direct grant)"
```

### Sorting and filtering

Add `WHERE` clauses for filtering and `ORDER BY` for sorting. Parameterize all user input to prevent SQL injection:

```go
// Filter by role name
query += " AND r.name ILIKE $4"

// Sort by created date descending
query += " ORDER BY r.created_at DESC"

// Pagination
query += " LIMIT $5 OFFSET $6"

// Call with all parameters
err := db.SelectContext(ctx, &roles, query, tenantID, filter, sort, limit, offset)
```

### Tenant isolation

Always include `tenant_id` in your `WHERE` clauses. The ACL tables do not enforce tenant isolation at the database level — it is your responsibility:

```go
// Good: filters by tenant
WHERE r.tenant_id = $1

// Bad: forgets tenant
WHERE r.name = $1  -- could leak data to other tenants!
```

### Performance tips

- Add an index on `(subject_id, subject_type, tenant_id)` if you query `subject_roles` or `subject_permissions` by subject often.
- Add an index on `(role_id, permission_id)` for `role_permissions` if you frequently list permissions in a role.
- For large tables, consider limiting query results and using pagination (`LIMIT` and `OFFSET`).
- If you do complex joins or aggregations frequently, consider materializing a view in the database.

---

## When to use SQL vs. the engine

Use the engine's methods for:
- Loading a user's permissions to check on the server or send to the browser
- Loading a single role to display or edit
- A simple list of all roles or all permissions

Use custom SQL for:
- Paginated tables with sorting and filtering
- Reporting queries (e.g., "which users hold the admin role?")
- Advanced joins across your own tables and the ACL tables
- Count or aggregate queries (e.g., "how many users hold each role?")

The ACL tables are yours to query. Build the screens you need.

::: tip Query package
If you need paginated lists with sorting and filtering already built, consider using the [Query package](/packages/query/). It provides a query builder that works with schema definitions, handles pagination and sorting automatically, and can be extended to work with the ACL tables. Many complex screens can be built without writing raw SQL when you leverage the Query package.
:::
