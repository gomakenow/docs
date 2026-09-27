---
title: Testing — ACL
description: How to test handlers that use the engine, and how the package tests itself.
---

# Testing

There are two separate testing layers. Getting them confused leads to tests that either miss real problems or silently skip your own migrations.

| Layer | Database | When to use it |
|---|---|---|
| Package tests (`backend/acl`) | In-memory SQLite from `acl/testutil` | Only when you are changing the package itself |
| Your handler and service tests | Your app's Postgres test database | Every test that exercises a handler or service using the engine |

---

## Application tests: build a real engine

Your handler tests should call `acl.New` the same way `main.go` does. Do not put a fake `Can` interface in front of the engine. The things worth testing in your handlers — that a specific route requires a specific permission, that superadmin bypasses a gate, that a machine cannot receive a direct grant — only work correctly when the real engine runs.

Before you can do that, the ACL migration has to be applied to your test database. Publish it once the same way you do in development:

```bash
make -C backend/acl migrate-publish
make migrate-up-test   # however you apply migrations against the test database
```

Then in tests:

```go
func TestRefundRequiresPermission(t *testing.T) {
    db := openAppTestDB(t)          // your existing helper that opens a test DB connection
    ctx := context.Background()

    engine, err := acl.New(db, acl.Config{TenantMode: acl.SingleTenant}, nil)
    require.NoError(t, err)

    // Alice has the billing role, which includes InvoiceRefund
    alice := acl.Actor{ID: "1", Type: acl.SubjectUser}
    role, err := engine.CreateRole(ctx, acl.NoTenant, "billing", nil)
    require.NoError(t, err)
    require.NoError(t, engine.SetRolePermissions(ctx, role.ID, []string{acl.InvoiceRefund}))
    require.NoError(t, engine.AssignRole(ctx, alice, role.ID, acl.NoTenant))

    ok, err := engine.Can(ctx, alice, acl.InvoiceRefund, acl.NoTenant)
    require.NoError(t, err)
    require.True(t, ok)

    // Bob has no roles
    bob := acl.Actor{ID: "2", Type: acl.SubjectUser}
    ok, err = engine.Can(ctx, bob, acl.InvoiceRefund, acl.NoTenant)
    require.NoError(t, err)
    require.False(t, ok)
}
```

If your test database uses transaction rollback for isolation, the roles and assignments you write inside the test are cleaned up automatically when the transaction rolls back.

---

## Do not stub Can

A common shortcut is to define a `CanChecker` interface with a fake that always returns true. Resist this. When you stub `Can`, you are no longer testing your application's access control — you are testing your handler's ability to call a method. The real questions disappear:

- Does this route check the right permission name?
- Does superadmin actually bypass the gate?
- Does a machine get refused a direct grant?
- Does revoking a role immediately affect the next check?

Stub the things that are genuinely yours: email sending, payment providers, external HTTP calls. Those are side effects of the handler, not the thing you are testing. The engine is not a side effect — it is the logic.

---

## Testing with DisableCache

Each `acl.New` has its own in-memory cache. If a test builds two engines on the same database — one to write grants, one to read them — the reading engine will not see what the writing engine cached. That is not a bug. That is how a second process would behave.

For most tests this does not matter, because you use one engine for everything. If you write through engine A and read through engine B, set `DisableCache: true` on the reading engine. Every `Can` will read from the database, where the rows actually exist.

```go
reader, _ := acl.New(db, acl.Config{
    TenantMode:   acl.SingleTenant,
    DisableCache: true,
}, nil)
```

---

## Running the package tests

The package has its own test suite that runs on in-memory SQLite. You do not need your development database or `.env` to run these:

```bash
make -C backend/acl test-acl
make -C backend/acl test-acl TestCanViaRoleAndDirectGrant  # one test
```

These tests cover things like: permission set resolution, the superadmin bypass, tenant isolation, cache invalidation on writes, machine subject restrictions, direct grant refusal, and the HTTP middleware status codes.

---

## Package `testutil` — for people changing `backend/acl`

If you are modifying the package itself, `acl/testutil` gives you an isolated SQLite engine without any of your app's tables:

```go
func TestSomething(t *testing.T) {
    engine, db, cache := testutil.NewEngine(t, acl.SingleTenant)
    // engine is a real *acl.Engine on a fresh SQLite database
    // db is the *gorm.DB backing it
    // cache is the *acl.MemoryCache so you can assert invalidation
}
```

`OpenTestDB` creates a fresh in-memory SQLite database named after `t.Name()`, runs the five `CREATE TABLE` statements, seeds the superadmin role, and closes the connection when the test finishes. `NewEngine` wraps it with `acl.New`.

**Do not import `acl/testutil` from your handler tests.** If you do, those tests run on a SQLite database that has none of your app's tables and none of your migrations. The test will pass, and the bug it is supposed to catch will not be caught.

When you add a feature to the package, add a test case next to the behavior it protects. A table-driven test that covers "role grant," "direct grant," and "no grant" for the same permission name exercises the `UNION` in one short function. Run `make -C backend/acl test-acl` before sending a PR.
