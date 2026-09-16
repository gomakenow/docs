---
title: Testing — Auth
description: SQLite helpers for the auth package itself, and how application tests should construct a real Engine.
---

# Testing

There are two layers. They are easy to mix up.

| Layer | Database | What you import |
|---|---|---|
| Package tests (`backend/auth`) | In-memory SQLite from `auth/testutil` | `auth/testutil` **inside the package only** |
| Your handler / service tests | Your app test database | `auth.New` the same way production does |

`auth/testutil` is **not** an application testing API. It exists so the package can run `make test-auth` without Postgres and without your `users` table.

---

## Running the package tests

```bash
make -C backend/auth test-auth
make -C backend/auth test-auth TestAttemptRejectsWrongPassword
```

Those tests use SQLite and a tiny fake user type. They do not read your `.env` and they do not touch your development database.

---

## Application tests: use a real engine

Handler tests should mint and check **real JWTs**. Do not stub `IssueSession` / `Attempt` / `ValidateCredential` behind an interface unless you are testing something that is not auth (for example “does this handler queue an email”). If the handler calls `engine.Attempt`, the test should call `Attempt` on a test engine too.

```go
func TestLogin(t *testing.T) {
    db := openAppTestDB(t) // your existing test helper
    cfg := auth.Config{
        JWTSecret: "test-jwt-secret-not-for-production",
        Issuer:    "https://auth.test",
        AppKey:    testAppKey(t), // 32 random bytes
        AppName:   "Test",
    }.WithDefaults()

    engine, err := auth.New[*User](cfg, db)
    require.NoError(t, err)

    hash, err := auth.Hash("secret-password")
    require.NoError(t, err)
    user := seedUser(t, db, hash)

    out, err := engine.Attempt(user.Email, "secret-password", "")
    require.NoError(t, err)
    require.NotEmpty(t, out.Token)

    // pass engine into the handler the same way main.go does
}
```

`Config.Now` can freeze time so expiry tests are deterministic:

```go
now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
cfg.Now = func() time.Time { return now }
```

If a test needs `GenerateReset`, point `db` at a connection that already has `password_reset_tokens` (your migrated test database). Do not copy the SQLite `CREATE TABLE` from `testutil` into app tests — run the published migration against the test DB like every other kit table.

---

## What not to mock

Avoid a `TokenGenerator` interface that exists only so tests can return `"fake-jwt"`. That hides the purpose claim, expiry, and `sessions_valid_after` behaviour. Prefer:

1. Construct `auth.New` with a test secret.
2. Call the handler.
3. Parse the JSON token (or `Authorization` header) with `engine.ValidateSession` or `engine.ValidateCredential`.

Stub **your** side effects instead: email sender, OAuth userinfo HTTP, analytics. Those are not the auth package.

---

## Package `testutil` (for kit contributors)

If you are changing `backend/auth` itself:

```go
func TestSomething(t *testing.T) {
    db := testutil.OpenTestDB(t)
    engine := testutil.NewEngine[*fakeUser](t, db)
}
```

`OpenTestDB` creates an isolated in-memory SQLite named after `t.Name()`, creates `password_reset_tokens`, and closes the connection on cleanup. `NewEngine` / `NewConfig` fill in a valid `Config` (random `AppKey`, test JWT secret). `NewEngineAt` / `NewConfigAt` take a clock.

Application tests should not import this package. If they do, they silently skip your `users` lookups and your real migrations.
