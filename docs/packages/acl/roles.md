---
title: Roles and grants
description: Create roles, assign them to people, give individual permissions, and load lists for screens.
---

# Roles and grants

A **role** is a reusable bundle of permissions. You create it once with a name, fill it with permission names, and then assign it to users. Everyone who holds that role automatically has all the permissions it contains. A role makes it easy to manage access: change the role, and everyone holding it changes with it.

When you want one user to have an extra permission that the rest of their role does not include, use a **direct grant**. It is a permission written to just that user, separate from any role. Direct grants are rare, but they are useful when one person needs one specific power that nobody else in their role should have.

This page shows you how to work with both: create and modify roles, assign them to users, grant individual permissions, and read back what users and roles have so you can display it on a screen.

---

## Creating a role

A role starts with a name and an empty list of permissions. The name must be unique in its tenant.

```go
role, err := engine.CreateRole(ctx, acl.NoTenant, "support", nil)
if err != nil {
    return err
}
```

`engine.CreateRole` takes four arguments:

- `ctx` — the request context
- The tenant ID — `acl.NoTenant` for single-tenant apps, or a specific organization ID for multi-tenant ones
- A name for the role — `"support"`, `"editor"`, `"viewer"`, etc. The name must be unique within the tenant
- An optional JSON metadata map (`nil` if you have nothing to store)

The method returns the newly created role, including a unique ID that you will use to assign it to people or modify it. If you try to create a second role with the same name in the same tenant, you get `ErrRoleExists`.

The optional fourth argument is a JSON map for your own use. For example, you might store a description, a UI color, or an external system ID. The ACL engine saves it and never reads it. The screen that manages roles can display whatever metadata you include.

---

## Adding and removing permissions from a role

Once the role exists, fill it with permissions. You can set the entire list at once, or add and remove individual permissions.

### Setting the entire list at once

`engine.SetRolePermissions` replaces the entire permission list. Every permission you want the role to have must be named in the slice you pass. Permissions not in the slice are removed.

```go
err = engine.SetRolePermissions(ctx, role.ID, []string{
    acl.TicketView,
    acl.TicketReply,
})
if err != nil {
    return err
}
```

After this call, anyone holding the `support` role can view tickets and reply to them, and nothing else (unless they have direct grants).

Every permission name you include must exist in your `permission.go` catalog. If you misspell a permission or include a name that was never declared, the call returns `ErrPermissionNotFound`.

### Adding or removing one permission

If you only want to add or drop a single permission without respecifying the whole list, use the single-permission methods:

```go
// Add one permission to the role
err = engine.AddPermissionToRole(ctx, role.ID, acl.InvoiceRefund)

// Remove one permission from the role
err = engine.RemovePermissionFromRole(ctx, role.ID, acl.InvoiceRefund)
```

When you add a permission that the role already has, the call succeeds but does nothing — it does not create a duplicate row. When you remove a permission that the role does not have, the call also succeeds. This makes it safe to call these methods without checking the current state first.

When you remove a permission from a role, that permission goes away for *everyone* who holds that role. If one user has `invoice.refund` because of the role, they lose it. If they also have `invoice.refund` from a direct grant, the direct grant remains — removing it from the role does not touch the grant.

### Deleting a role

`engine.DeleteRole` removes the role entirely from the database.

```go
err = engine.DeleteRole(ctx, role.ID)
if err != nil {
    return err
}
```

When you delete a role, every user who had it loses it. The role assignments are cascaded away. The role name becomes available for reuse. If you try to delete a role ID that does not exist, you get `ErrRoleNotFound`.

One built-in role cannot be deleted: `superadmin`. See the [Superadmin](./superadmin.md) page for details on that reserved role.

---

## Assigning a role to a user

Creating a role does nothing until you assign it to someone. A user with no roles has no permissions (unless they have direct grants).

```go
err = engine.AssignRole(ctx, user, role.ID, acl.NoTenant)
if err != nil {
    return err
}
```

`engine.AssignRole` takes a subject (usually your user model), a role ID, and a tenant. It creates the link between them. After this call, `engine.Can` for any permission in that role returns `true` for that user.

If you call `AssignRole` multiple times for the same user and the same role, the second call does nothing — there is only one row linking them. Assigning the same role twice is safe.

A user can hold multiple roles at the same time. If you assign both the `support` role and the `admin` role to one user, that user has every permission from both roles combined.

### Assigning a role by name

`engine.AssignRole` requires the role ID, which you have only at the moment you created the role. In most cases, you do not have the role ID — a user clicks "support" in a list, or you are seeding data and the role name is hardcoded in a configuration file. For these cases, use `engine.AssignRoleByName`:

```go
err = engine.AssignRoleByName(ctx, user, "support", acl.NoTenant)
if err != nil {
    return err
}
```

The engine looks up the role named `"support"` in the specified tenant, then assigns it to the user. If no role with that name exists in the tenant, you get `ErrRoleNotFound`.

### Revoking a role

`engine.RevokeRole` removes the link between a user and a role.

```go
err = engine.RevokeRole(ctx, user, role.ID, acl.NoTenant)
if err != nil {
    return err
}
```

After this call, the user no longer has the permissions from that role. However, they keep any direct grants — those are separate. If you revoke the `support` role but previously used `engine.Grant` to give them `invoice.refund` as a direct grant, they still have `invoice.refund`.

If the user did not have the role you are trying to revoke, the call still succeeds and does nothing. This makes it safe to revoke without checking first.

---

## Direct grants — one permission for one user

A direct grant is a permission written directly to one user, separate from any role. It is useful when one person needs one specific power that their role does not include, and you do not want to give that power to everyone who holds the role.

For example, suppose you have a `support` role for handling tickets. Most of the support team can view and reply to tickets, but only one person is allowed to refund invoices. You could create a separate `invoice-closer` role and assign it to just that person, but that is extra machinery for one person. Instead, use `engine.Grant` to give that one person the `invoice.refund` permission:

```go
err = engine.Grant(ctx, user, acl.InvoiceRefund, acl.NoTenant)
if err != nil {
    return err
}
```

Now that user has `invoice.refund`. The rest of the `support` role does not have it — only that one person.

`engine.Can` does not distinguish between a permission that came from a role and one that came from a direct grant. Both are treated equally. If you need to display them separately on a screen, you can load them separately and track which is which (see "Loading lists for screens" below).

### Removing a direct grant

`engine.Revoke` removes a direct grant.

```go
err = engine.Revoke(ctx, user, acl.InvoiceRefund, acl.NoTenant)
if err != nil {
    return err
}
```

This does not affect the user's roles. If `invoice.refund` is also in a role the user holds, they keep it from the role. If it was only a direct grant, it is gone.

If you try to revoke a permission the user does not have (either from a role or a direct grant), the call still succeeds and does nothing.

::: warning Direct grants are for users only
`engine.Grant` and `engine.Revoke` accept `acl.SubjectUser` only. If you try to grant or revoke for a machine (an `acl.Actor` with type `acl.SubjectMachine`), you get `ErrDirectGrantsNotAllowedForSubjectType`. Machines can hold roles, just like users, but not direct grants. See [People and machines](./subjects.md) for details.
:::

::: info Superadmin ignores grants and revokes
If you call `engine.Grant` or `engine.Revoke` on a superadmin user, the call succeeds but does nothing — no row is written. A superadmin already has every permission. See [Superadmin](./superadmin.md) for details.
:::



For detailed guidance on loading and displaying roles and permissions on screens — including pagination, sorting, and filtering — see [Displaying access](./screens.md).
