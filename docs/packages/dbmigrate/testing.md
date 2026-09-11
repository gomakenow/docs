---
title: Testing — dbmigrate
description: Apply real SQL against in-memory SQLite in Go tests.
---

# Testing

Package tests for `go-dbmigrate` itself use in-memory SQLite. You can do the same in your app: load the real migration files, apply them to a throwaway database, assert tables exist, then rollback.

This does **not** replace applying migrations against a real Postgres when your SQL uses Postgres-only types. Use SQLite for engine behaviour and for SQL that is dialect-portable. Use a test Postgres when the files are Postgres-specific.

---

## In-memory SQLite

```go
func TestMigrationsApply(t *testing.T) {
    db, err := sqlite.Open("file:" + t.Name() + "?mode=memory&cache=shared")
    require.NoError(t, err)
    t.Cleanup(func() { _ = db.Close() })

    migs, err := dbmigrate.LoadPath("migrations")
    require.NoError(t, err)

    m := dbmigrate.New(db, sqlite.Dialect(), "")
    ctx := context.Background()

    require.NoError(t, m.Up(ctx, migs))

    pending, err := m.Status(ctx, migs)
    require.NoError(t, err)
    require.Empty(t, pending)

    hist, err := m.History(ctx)
    require.NoError(t, err)
    require.Len(t, hist, len(migs))
}
```

Give each test its own `file:{t.Name()}?mode=memory&cache=shared` name so parallel tests do not share a database.

---

## Checksum guard

If you need to prove an edited applied file is rejected:

```go
require.NoError(t, m.Up(ctx, migs))
// overwrite the .up.sql on disk, LoadPath again
err = m.Up(ctx, migs2)
require.Error(t, err)
require.Contains(t, err.Error(), "already applied but its .up.sql has changed")
```

---

## Rollback

Every file you intend to rollback in the test must have a down. Apply, rollback one batch, then `History` should be empty if that was the only batch.

```go
require.NoError(t, m.Up(ctx, migs))
require.NoError(t, m.Rollback(ctx, migs, 1))
hist, err := m.History(ctx)
require.NoError(t, err)
require.Empty(t, hist)
```

---

## `check` in CI

You do not need a database to catch broken pairs:

```sh
dbmigrate check --dir ./migrations
```

Fails on duplicate names and on a `.down.sql` with no matching `.up.sql`.
