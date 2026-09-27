---
title: Superadmin
description: A built-in bypass role that grants all permissions. Configured at startup or assigned in code.
---

# Superadmin

A **superadmin** is a special role that bypasses all permission checks. When someone is a superadmin, `engine.Can` returns `true` for every permission, even ones that do not exist in your catalog yet. It is a bypass, not a regular role with a list of permissions you can edit.

Every ACL instance has one built-in superadmin role, created at startup and protected from modification. You can turn it on in three ways: by hardcoding a user ID at startup, by matching an email address on each check, or by assigning it in code when you have a user in hand.

---

## Configuring superadmin at startup

When you create the engine with `acl.New`, pass a config with `SuperadminEmailOrID` set to either a user ID or an email address. This determines who is the superadmin before the application starts.

### By user ID

If you know the superadmin's user ID at startup, set `SuperadminEmailOrID` to that ID as a string.

```go
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    SuperadminEmailOrID: "42",  // User 42 is the superadmin
})
```

When the engine starts, it automatically assigns the built-in superadmin role to user `42`. If you start the application again, the assignment is not created twice — the role is already assigned.

`engine.Can` checks if the user is the superadmin by checking if their role assignments include the superadmin role.

### By email address

If you want the superadmin to be whoever logs in with a specific email address, set `SuperadminEmailOrID` to that email.

```go
engine, err := acl.New(ctx, db, &acl.Config{
    SubjectFunc: subjectFunc,
    SuperadminEmailOrID: "owner@example.com",
})
```

The ACL package does not have a users table, so it cannot look up that email address at startup. Instead, on every call to `engine.Can` or `engine.IsSuperadmin`, if the subject is a user, the engine calls `GetEmail()` on them and compares the address (case-insensitive) to the configured one. If they match, the user is the superadmin.

For this to work, your user model must implement the optional `GetEmail()` method. See [People and machines](./subjects.md) for details.

The advantage of email-based superadmin is that you can change who the superadmin is without restarting. The disadvantage is that `engine.IsSuperadmin` requires a user object with `GetEmail()` implemented. Machines (represented by `acl.Actor`) do not have emails and cannot be email-based superadmins.

### Leaving superadmin unconfigured

If you do not set `SuperadminEmailOrID` (leave it as an empty string), there is no automatic superadmin. You can still assign the superadmin role in code with `engine.AssignSuperadmin`.

---

## Assigning superadmin in code

After startup, you can assign or revoke the superadmin role using these methods.

**`engine.AssignSuperadmin`** makes a user the superadmin, creating the role assignment in the database.

```go
err := engine.AssignSuperadmin(ctx, user)
if err != nil {
    return err
}
```

If the user already holds the superadmin role, the call succeeds and does nothing — it does not create a second row.

**`engine.IsSuperadmin`** checks if a user is the superadmin. It returns `true` if:
- The user holds the superadmin role (by assignment or email match), or
- The configured `SuperadminEmailOrID` is an email and matches the user's `GetEmail()` result

```go
is_superadmin, err := engine.IsSuperadmin(ctx, user)
if err != nil {
    return err
}

if is_superadmin {
    // Allow everything
}
```

**`engine.RevokeSuperadmin`** removes the superadmin role from a user.

```go
err := engine.RevokeSuperadmin(ctx, user)
if err != nil {
    return err
}
```

If the user did not have the role, the call succeeds and does nothing. If the superadmin is configured by email, this method only removes the role assignment — the email match still works on future checks.

---

## Constraints on the superadmin role

The superadmin role is special. You cannot treat it like a regular role.

### You cannot modify its permissions

The superadmin role has no explicit permission list. Its power comes from being the bypass, not from a collection of permissions you edit. These calls are forbidden:

- `engine.AddPermissionToRole` returns `ErrSuperadminBypassesPermissions`
- `engine.RemovePermissionFromRole` returns `ErrSuperadminBypassesPermissions`
- `engine.SetRolePermissions` returns `ErrSuperadminBypassesPermissions`

### You cannot delete it or create another

The superadmin role is protected. These calls are forbidden:

- `engine.DeleteRole` on the superadmin role returns `ErrProtectedRole`
- `engine.CreateRole` with the name `"superadmin"` in the `"default"` tenant returns `ErrProtectedRole`

(In multi-tenant systems, you can create a role named `"superadmin"` in other tenants — only the default one is protected.)

### Machines cannot be superadmin

`engine.AssignSuperadmin` accepts a user only. If you try to assign the superadmin role to a machine (an `acl.Actor` with type `acl.SubjectMachine`), you get `ErrSuperadminRequiresUser`. Machines can hold regular roles, but the superadmin bypass is reserved for people.

### Granting and revoking permissions on a superadmin does nothing

If you call `engine.Grant` or `engine.Revoke` on a user who already holds the superadmin role, the calls succeed but do nothing — no row is written. There is no point in giving a superadmin individual permissions on top of their bypass.

---

## Displaying superadmin to users

When you load a user's permissions with `engine.PermissionsFor`, the result is a flat list of permission names from their roles and direct grants. It does not include every permission in the catalog just because `engine.Can` would return `true` for all of them. A superadmin's permission list looks like everyone else's — just the permissions they actually hold.

Similarly, `engine.RoleNames` shows the roles a user is assigned to. If the user became a superadmin through email matching (not role assignment), their role list does not include `"superadmin"` — it will be empty or contain only their other roles.

To display that someone is a superadmin on the screen, do not try to build a fake list of every permission. Instead:

1. Call `engine.IsSuperadmin` to get the true answer.
2. Send the result as a separate boolean flag (`is_superadmin: true`) to the browser.
3. The UI treats that flag as "this user can do anything."

```go
permissions, err := engine.PermissionsFor(ctx, user, tenantID)
is_superadmin, err := engine.IsSuperadmin(ctx, user)

// Send to browser:
// {
//   "permissions": ["ticket.view", "ticket.reply"],
//   "is_superadmin": true
// }

// The browser uses is_superadmin to render "full access" instead of
// trying to check a list that will never be complete.
```

This approach keeps the bypass transparent and does not go stale when you add new permissions to the catalog.

---

## Email-based superadmin in multi-tenant systems

If you are using email-based superadmin in a multi-tenant system, the email match applies globally — the owner is the superadmin in every tenant. This is usually what you want for the person who owns the entire application.

If you need per-tenant superadmins, use user ID-based assignment instead and assign the role in each tenant separately.
