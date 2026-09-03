---
title: Testing — Media
description: In-memory SQLite helpers and a mock storage driver for testing media package code.
---

# Testing

The `media/testutil` package gives you an isolated in-memory database and a mock storage driver so you can test any code that calls `media.Upload`, `media.Delete`, or `media.ResolveURL` — no real Postgres and no real storage backend needed. Each helper is designed to keep tests fast, isolated, and free of shared state.

---

## testutil.OpenTestDB

```go
db := testutil.OpenTestDB(t)
```

Returns an in-memory SQLite database with the `media` table already created. Each call produces its own database keyed on `t.Name()` — parallel sub-tests never share state. A cleanup to close the connection is registered automatically via `t.Cleanup`.

No Postgres connection, no `backend/db`, no migrations tool needed. The table is created inline when the function is called.

```go
func TestUploadCreatesRow(t *testing.T) {
    db := testutil.OpenTestDB(t)

    drv := &testutil.MockStorageDriver{}
    drv.On("Put", "images/test.png", mock.Anything).Return(nil)

    m, err := media.Upload(db, drv, "images/test.png", []byte("fakedata"))
    require.NoError(t, err)
    require.NotNil(t, m.ID)
    require.Equal(t, "images/test.png", m.ObjectKey)
    drv.AssertExpectations(t)
}
```

---

## testutil.BeginTx

```go
tx := testutil.BeginTx(t, db)
```

Starts a transaction on an existing `db` and registers `tx.Rollback()` via `t.Cleanup`. Use this inside sub-tests so each one writes rows and has them automatically discarded when it ends — no manual teardown.

```go
func TestDelete(t *testing.T) {
    db := testutil.OpenTestDB(t)

    t.Run("removes bytes and row", func(t *testing.T) {
        tx := testutil.BeginTx(t, db)
        // write and delete inside tx — rolled back when this sub-test ends
    })

    t.Run("returns ErrNotFound for unknown id", func(t *testing.T) {
        tx := testutil.BeginTx(t, db)
        drv := &testutil.MockStorageDriver{}
        err := media.Delete(tx, drv, uuid.New())
        require.ErrorIs(t, err, mediamodel.ErrNotFound)
    })
}
```

---

## testutil.MockStorageDriver

A testify mock that fully implements `drivers.StorageDriver`. Use it to control what `Put`, `Get`, `Delete`, `URL`, and `SignedURL` return without touching a real storage backend.

```go
drv := &testutil.MockStorageDriver{
    PrivateDriver: false,                          // IsPublic() returns true
    DriverType:    drivers.StorageDriverTypeLocal, // Type() returns "local"
}

// Tell the mock what to return when Put is called
drv.On("Put", "images/test.png", mock.Anything).Return(nil)

// After the test, verify every expected call was made
drv.AssertExpectations(t)
```

| Field | Default | Effect |
|---|---|---|
| `PrivateDriver` | `false` | `IsPublic()` returns `!PrivateDriver` — set `true` to simulate a private driver |
| `DriverType` | `StorageDriverTypeLocal` | What `Type()` returns — use `StorageDriverTypeS3` for S3 scenarios |

To simulate a failed `Put` (testing the compensating delete in `Upload`):

```go
drv.On("Put", mock.Anything, mock.Anything).Return(errors.New("disk full"))
```

To simulate a successful upload followed by a failed DB insert (testing that `Upload` cleans up the bytes):

```go
drv.On("Put", "images/test.png", mock.Anything).Return(nil)
drv.On("Delete", "images/test.png").Return(nil)  // called by Upload on DB failure
// then close the DB connection before calling Upload to force a DB error
```

---

## Running the tests

```sh
make -C backend/media test-media
```

To run a single test by name:

```sh
make -C backend/media test-media TestUploadCreatesRow
```
