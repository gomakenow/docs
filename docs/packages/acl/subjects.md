---
title: People and machines
description: Subject types. Users can hold direct grants and superadmin. Machines hold roles only.
---

# People and machines

At the heart of the ACL system is the **subject**: the identity being checked. Every subject is two pieces of information working together:

- An **ID** — a unique identifier, usually a number converted to a string
- A **type** — a label saying whether this is a person or a machine

These two pieces form a composite key. User `7` and a machine process `7` are completely different subjects. They cannot be confused. That is why the type is part of the identity.

The package defines two subject types, stored as strings in the database:

| Constant | Stored value | Purpose |
|---|---|---|
| `acl.SubjectUser` | `"user"` | A person — someone who logs in. Can hold roles, direct grants, and the superadmin role. |
| `acl.SubjectMachine` | `"machine"` | Software — an API key, a background job, a bot, a scheduled cron task. Can hold roles only. |

Do not invent new types like `"api_key"` or `"bot"`. If it is software, use `acl.SubjectMachine`. The single type for all machines keeps the namespace simple and forces you to name your machines clearly.

---

## People — your user model

When you want to grant permissions to a person, you work with your user model. To make the ACL engine understand who the user is, your user type must implement the `Subject` interface: two required methods and one optional method.

### The Subject interface

The two required methods are:

**`GetID() string`** — Return the user's unique identifier as a string. Usually you convert a numeric ID or UUID: `fmt.Sprintf("%d", u.ID)` or `u.ID.String()`. The method must never return an empty string; `engine.Can` rejects blank IDs with `ErrEmptySubject`.

**`GetType() string`** — Return `acl.SubjectUser`, the string `"user"`. This method also must never return empty; a blank type returns `ErrEmptySubjectType`.

Here is a minimal user model:

```go
type User struct {
    ID    int64
    Email string
    // ... other fields
}

func (u *User) GetID() string {
    return strconv.FormatInt(u.ID, 10)
}

func (u *User) GetType() string {
    return acl.SubjectUser
}
```

These two methods are all the ACL engine strictly needs. From this point, your user can be assigned roles and direct grants, and the engine can check permissions against them.

### Optional: email-based superadmin detection

There is a third optional method, `GetEmail() string`, that enables one feature: **email-based superadmin detection**. If you configure the engine with a superadmin email address like `owner@example.com`, the engine can automatically recognize that user as the superadmin without them needing a special role.

Here is how it works: when you call `engine.Can` or `engine.IsSuperadmin`, if the engine is configured with a superadmin email, it calls `GetEmail()` on the user and compares the returned address (case-insensitive) to the configured one. If they match, the engine immediately returns `true` for every permission. No role check, no database query for that user's grants.

```go
type User struct {
    ID    int64
    Email string
}

func (u *User) GetID() string {
    return strconv.FormatInt(u.ID, 10)
}

func (u *User) GetType() string {
    return acl.SubjectUser
}

// Optional: enables email-based superadmin
func (u *User) GetEmail() string {
    return u.Email
}
```

If your superadmin is identified by user ID instead of email, or if you have not configured a superadmin at all, you can leave `GetEmail()` off. The engine will not call it. See the [Superadmin](./superadmin.md) page for full configuration details.

---

## Machines — software that needs permissions

Not every caller that checks permissions is a person. A background job that closes stale tickets, an API client that syncs data, or a webhook processor running on a schedule is just as much an identity that needs permission checks. These are machines.

Unlike people, machines are not stored in your user table. There is no database row for every cron job or API key. Instead, you assign a simple, memorable ID to each machine and use the machine type. When the machine calls your code, you construct an **actor** representing it.

### Creating and using actors

The simplest way to represent a machine is with `acl.Actor`, a small struct that implements the `Subject` interface:

```go
type Actor struct {
    ID   string // e.g., "cron-close-tickets", "importer-webhook"
    Type string // acl.SubjectMachine
}
```

When you need to check permissions for a machine, construct an actor and pass it to the engine:

```go
// Define your machine
cron := acl.Actor{
    ID:   "cron-close-tickets",
    Type: acl.SubjectMachine,
}

// Assign it a role so it has permissions
role, err := engine.CreateRole(ctx, acl.NoTenant, "ticket-closer", nil)
if err != nil {
    return err
}

// The role should have permission to close tickets
err = engine.SetRolePermissions(ctx, role.ID, []string{acl.TicketClose})
if err != nil {
    return err
}

// Assign the role to the cron job
err = engine.AssignRole(ctx, cron, role.ID, acl.NoTenant)
if err != nil {
    return err
}

// Later, when the cron job runs, check if it can close tickets
ok, err := engine.Can(ctx, cron, acl.TicketClose, acl.NoTenant)
if !ok {
    return fmt.Errorf("cron job is not allowed to close tickets")
}
```

### Naming machines

Machine IDs are global across your entire system. If you have multiple processes or services, they all share the same namespace. Use a clear prefix or a UUID to avoid accidental collisions:

- Good: `"cron-close-tickets"`, `"cron-send-digest"`, `"webhook-stripe-invoice"`, `"importer-api-key-abc123"`, `"847c6e8f-2a1c-4d2e-a5b3-9f7c8b1a2d3e"`
- Avoid: `"job1"`, `"process"` (too vague and easy to collide)

### Constraints on machines

Machines can hold roles, just like people. However, two operations are forbidden for machines:

**`engine.Grant` is refused** with `ErrDirectGrantsNotAllowedForSubjectType`. Direct grants are a human feature, useful when one person needs one specific permission outside a formal role. For machines, you should always use roles, because they are visible and auditable. If you grep your code for `engine.AssignRole` with a machine actor, you see exactly what permissions it has.

**Assigning the superadmin role is refused** with `ErrSuperadminRequiresUser`. Machines cannot be superadmins. The superadmin bypass is reserved for people in authority over the system.

As a result, `engine.IsSuperadmin` always returns `false` for a machine actor, regardless of what you configured. If you need a machine to have "full access", assign it a role that holds every permission.

### Machines in multi-tenant systems

A machine can act on behalf of one tenant, just like a person can. If you are building a system with multiple organizations, a webhook processor that runs in the context of one company's data uses `engine.Can` with that company's tenant ID, the same way a logged-in person does. A background task that works globally uses `engine.CanGlobal` or passes `acl.NoTenant`.

See the main documentation for details on [multi-tenant setups](./index.md).
