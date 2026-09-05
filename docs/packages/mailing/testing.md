---
title: Testing — Mailing
description: In-memory helpers for testing mailing queue and worker logic.
---

# Testing

The `mailing/testutil` package provides two helpers that spin up an isolated, in-memory SQLite database with all four mailing tables created. You can queue jobs, inspect what was inserted, and test worker behaviour — all without a real Postgres instance and without contacting Mailtrap or Mailgun.

Tests that go through your HTTP handlers use your app's normal test database. For those, construct `mailing.New` the same way production does, but point `OpenDB` at the test connection and inject a fake `Gateway`.

---

## testutil.OpenTestDB

`testutil.OpenTestDB` creates an in-memory SQLite database with all four mailing tables (`mailing_jobs`, `mailing_batches`, `mailing_recipients`, `mailing_commands`) already migrated. The connection is automatically closed at the end of the test.

```go
func TestSomething(t *testing.T) {
    db := testutil.OpenTestDB(t)

    // Use db directly with the mailing package functions.
    job, created, err := engine.Queue(db, mailing.Message{...})
}
```

Each test gets an isolated database named after `t.Name()`, so parallel tests do not share state.

---

## testutil.NewEngine

`testutil.NewEngine` calls `testutil.OpenTestDB` and then builds a `mailing.Engine` whose `OpenDB` points at that same database. It returns both.

```go
func TestQueueInsertsJob(t *testing.T) {
    engine, db := testutil.NewEngine(t)

    job, created, err := engine.Queue(db, mailing.Message{
        Type: "welcome",
        To:   "user@example.com",
        Render: func(r mailing.Recipient, ids mailing.IDs) (string, string, error) {
            return "Welcome", "<p>Hi " + r.Email + "</p>", nil
        },
    })

    require.NoError(t, err)
    require.True(t, created)
    require.Equal(t, "welcome", job.EmailType)
    require.Equal(t, "user@example.com", job.Recipient)
}
```

The engine returned by `NewEngine` uses the real `providers.NewGateway()` by default. For most queue tests, you do **not** call `engine.Start()` — you queue a job, then inspect `mailing_jobs` directly without the worker running.

If you want to test the full send path (worker claims job, calls provider, deletes row), replace the gateway with a fake:

```go
func TestWorkerSendsAndDeletesJob(t *testing.T) {
    sentTo := ""
    fakeGateway := &FakeGateway{
        SendFn: func(ctx context.Context, msg providers.Delivery) (string, error) {
            sentTo = msg.To
            return "fake-msg-id-123", nil
        },
    }

    _, db := testutil.NewEngine(t) // get the DB
    engine := mailing.New(mailing.Config{
        OpenDB:  func() (*gorm.DB, error) { return db, nil },
        Gateway: fakeGateway,
    })
    engine.Start()
    defer engine.Stop()

    _, _, err := engine.Queue(db, mailing.Message{
        Type:   "welcome",
        To:     "user@example.com",
        Render: func(r mailing.Recipient, _ mailing.IDs) (string, string, error) {
            return "Welcome", "<p>Hi</p>", nil
        },
    })
    require.NoError(t, err)

    // Give the worker time to pick up and process the job.
    time.Sleep(100 * time.Millisecond)

    require.Equal(t, "user@example.com", sentTo)

    // Job row should be gone after a successful send.
    var count int64
    db.Model(&mailing.Job{}).Count(&count)
    require.Equal(t, int64(0), count)
}
```

---

## Running the package tests

```sh
# Run all mailing package tests
make -C backend/mailing test-mailing

# Run a single test by name
make -C backend/mailing test-mailing TestQueueInsertsJob
```

These tests use only the in-memory SQLite database. They do not need a running Postgres instance or any provider credentials.
