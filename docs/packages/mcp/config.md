---
title: Configuration
description: Tune failure cooldown, token expiry, forward timeouts, and log cleanup.
---

# Configuration

<Badge type="warning" text="Requires ACL" />

The `mcp` package works with defaults out of the box. `db`, `AgentStore`, and the ACL engine are required. Everything else has a default. Change a value only when you have a reason.

---

## How configuration works

Two layers set the limits:

1. **Code** — The `mcp.Config` you pass to `mcp.New`. Zero values use the package defaults
2. **Settings** — Rows in `mcp_settings`. A row overrides the code value for that key

A missing settings row uses the code value. Change the settings rows through your admin API. A row change applies on the next tool call, so you do not restart the server.

```go
mcpEngine, err := mcp.New(db, mcp.Config{
    AgentStore:             MachineStore{DB: db},
    MaxConsecutiveFailures: 5,
    FailureCooldown:        90 * time.Second,
    MaxResponseChars:       50000,
    TokenExpiry:            90 * 24 * time.Hour,
    ForwardTimeout:         90 * time.Second,
    LogCleanupBatch:        15000,
    LogCleanupThreshold:    20000,
})
```

---

## Settings keys

| Key | Default | Meaning |
|---|---|---|
| `max_consecutive_failures` | 5 | Failures in a row before an agent is cooled down |
| `failure_cooldown_seconds` | 90 | How long a cooled-down agent is blocked |
| `max_response_chars` | 50000 | Longest tool result returned. Longer output is cut off |
| `token_expiry_days` | 90 | Lifetime of a new token |
| `forward_timeout_seconds` | 90 | How long a tool call may run before it is cancelled |
| `log_cleanup_batch` | 15000 | Oldest log rows one cleanup call deletes |
| `log_cleanup_threshold` | 20000 | Row count the log table must exceed before cleanup deletes |

Change a setting through your admin API. The package's settings handler does not check access, so protect that route with your app's admin auth:

```bash
PUT /admin/mcp/settings/max_consecutive_failures
{"value": 7}
```

A value that is not allowed returns `ErrInvalidSetting`. A key that does not exist returns `ErrUnknownSetting`.

---

## Failure cooldown

An agent that keeps failing is blocked. After `max_consecutive_failures` failures in a row, the agent is cooled down for `failure_cooldown_seconds`. During the cooldown, every call returns a rate-limited result without reaching your route.

Two statuses do not count toward the streak: `blocked` and `rate_limited`. Only real failures do.

::: info
The failure streak belongs to the agent. When you delete an agent, call `engine.ForgetAgent` so its tokens and failure streak are removed. Its log rows stay.
:::

---

## Token expiry

A new token expires after `token_expiry_days`. An expired token returns `401`. Issue a new token and update the client. The raw token is shown once when it is created, so store it in your client config right away.

A token can also be revoked through your admin API. A revoked token returns `401` at once.

---

## Forward timeout

Each tool call runs your route in process, with a timeout of `forward_timeout_seconds`. When the timeout passes, the request context is cancelled. Your handler must stop its work when `r.Context()` is cancelled. Otherwise the database work keeps running after the agent has given up.

Do not put a proxy in front of `/mcp` with a short write timeout. A slow tool call would be cut off before it finishes.

---

## Concurrency

The engine limits how many calls run at once, so agent traffic cannot take the whole database pool:

| Config field | Default | Limits |
|---|---|---|
| `MaxConcurrentDB` | 10 | Concurrent package database operations |
| `MaxConcurrentForwards` | 10 | Concurrent in-process tool forwards |

The two limits are separate, so tool traffic cannot take the whole host database pool.

---

## Log cleanup

Every tool call writes one `mcp_logs` row. The package does not delete them on its own. Call the cleanup job on a schedule:

```go
result, err := mcpEngine.CleanupLogs(ctx)
```

Each call deletes the oldest `log_cleanup_batch` rows. It deletes nothing unless the table has more rows than `log_cleanup_threshold`. The check is inside the package, so calling the job often is safe.

The package does not run a timer. Your host decides the schedule, for example once every 30 days from its existing job scheduler.

::: warning
Do not start a timer inside the package. Put the schedule in your host, next to the other background jobs.
:::

---

## Server identity

`ServerName` and `ServerVersion` are sent to the client when it connects. They default to `mcp` and `1.0.0`. Set them to your app name so the client shows the right server:

```go
mcp.Config{
    ServerName:    "myapp",
    ServerVersion: "2.4.0",
}
```

---

## Next steps

| Page | For |
|---|---|
| [Getting started](./index.md) | Setup and first tool call |
| [Publishing tools](./tools.md) | Routes, argument tags, naming |
| [Reference](./reference.md) | Admin routes, sentinel errors, tables |
