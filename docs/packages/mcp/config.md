---
title: Configuration
description: The limits the mcp package enforces, where each one is set, and what happens when a limit is reached.
---

# Configuration

An agent is software, and software makes mistakes at machine speed. One that gets a bad argument can retry the same call hundreds of times a minute. One that asks for a big list can pull a response of several megabytes. One that calls a slow route can hold a connection open for minutes. A token that nobody remembers can keep working for years.

The package guards against each of these with a limit. Every limit has a default, so the package is safe to run as it is. This page lists the limits, shows where each one is set, and explains what the agent sees when it reaches one.

## The limits at a glance

| Limit | What it stops | When the limit is reached |
|---|---|---|
| Failure cooldown | An agent that keeps sending failing calls | The agent is refused for a while |
| Forward timeout | A tool call that runs too long | The call is cancelled and the agent gets a `timeout` error |
| Response size | A result too big to return | The result is cut off and ends with `[truncated]` |
| Concurrency | Too many calls running at the same time | The call waits for a free slot, then fails with a `rate_limited` error |
| Token expiry | A token that stays valid forever | The token stops working with `401` |
| Log cleanup | The `mcp_logs` table growing without end | Old log rows are deleted, when you run the cleanup |

Each of these is covered in its own section below.

---

## Where a limit's value comes from

Every limit has up to three possible values. The package uses the first one it finds, in this order:

```
1. A row in the mcp_settings table      ← wins when it exists
2. A field on the mcp.Config you passed to mcp.New
3. The package default                  ← used when neither of the above is set
```

Here is what that means for one limit, the failure cooldown, which defaults to 90 seconds:

| `Config.FailureCooldown` | Row in `mcp_settings` | Cooldown the package uses |
|---|---|---|
| not set | none | 90 seconds (the package default) |
| `2 * time.Minute` | none | 2 minutes (from `Config`) |
| `2 * time.Minute` | `failure_cooldown_seconds = 300` | 5 minutes (the row wins) |
| not set | `failure_cooldown_seconds = 300` | 5 minutes (the row wins) |

The two places also differ in how they change:

| | `mcp.Config` | `mcp_settings` row |
|---|---|---|
| Where you write it | Go code, in the call to `mcp.New` | The admin handler, with `PUT /settings/{key}` |
| When it takes effect | After a restart | On the next tool call |
| Which limits it covers | All of them, plus concurrency, server identity and a few others | The seven limits in the table below |

So `Config` is for the values your app starts with, and a row is for changing a limit while the server is running. Concurrency is the one group that only `Config` can set.

```go
mcpEngine, err := mcp.New(db, mcp.Config{
    AgentStore:      MachineStore{DB: db},
    FailureCooldown: 2 * time.Minute,
})
```

This call changes one limit and leaves every other limit at its default.

---

## The limits

Each limit has a `Config` field, a settings key, a default, and a range. The range applies to values written to `mcp_settings`.

| Config field | Settings key | Default | Allowed range | What it limits |
|---|---|---|---|---|
| `MaxConsecutiveFailures` | `max_consecutive_failures` | 5 | 1 to 100 | Failed calls in a row before an agent is cooled down |
| `FailureCooldown` | `failure_cooldown_seconds` | 90 seconds | 1 to 86400 | How long a cooled-down agent is refused |
| `MaxResponseChars` | `max_response_chars` | 50000 | 100 to 1000000 | The longest tool result the agent receives |
| `TokenExpiry` | `token_expiry_days` | 90 days | 1 to 3650 | The lifetime of a newly issued token |
| `ForwardTimeout` | `forward_timeout_seconds` | 90 seconds | 1 to 600 | How long one tool call may run |
| `LogCleanupBatch` | `log_cleanup_batch` | 15000 | 1 to 100000 | Rows one cleanup call deletes |
| `LogCleanupThreshold` | `log_cleanup_threshold` | 20000 | 0 to 10000000 | Rows the log table must exceed before cleanup deletes |

Settings values are whole numbers. The time-based keys are in seconds or days, as their names say, while the `Config` fields use `time.Duration`.

### Changing a setting at runtime

Settings are changed through the package's admin handler, which serves `PUT /settings/{key}` relative to where you mount it. See [Reference](./reference.md) for the full list of routes.

```bash
curl -X PUT http://localhost:8003/admin/mcp/settings/failure_cooldown_seconds \
  -H "Content-Type: application/json" \
  -d '{"value": 300}'
```

A value outside the allowed range fails with `ErrInvalidSetting`. A key that is not in the table fails with `ErrUnknownSetting`. In both cases nothing is saved.

The package reads settings on each tool call, so a new value takes effect on the next call. A new value for a cleanup setting takes effect on the next cleanup call.

---

## Failure cooldown

The package keeps a count of consecutive failures for each agent. Every tool call changes that count:

| Result of the call | What happens to the count |
|---|---|
| Success (a `2xx` from your route) | Reset to 0 |
| Failure: any other result, including a rejected argument, a timeout, a panic, or a `4xx` or `5xx` from your route | Goes up by 1 |
| `rate_limited`: your route answered `429`, or the forward concurrency limit was reached | Unchanged |
| `blocked`: the call was refused because the agent is in cooldown | Unchanged |

When the count reaches `max_consecutive_failures`, the agent is blocked for `failure_cooldown_seconds`, and the count goes back to 0.

While the agent is blocked, each call is refused before it reaches your route. The agent gets a tool error with the code `cooldown`, a message, and `retry_after_seconds` with the time left. The refused call is still written to `mcp_logs`, with the status `blocked`.

When the cooldown ends, the next call goes through, and the count starts again from 0.

```
fail  fail  fail  fail  fail   →  cooldown (90 s)  →  next call is allowed
 1     2     3     4     5
```

The cooldown belongs to the agent, not to a token. Every token of that agent is refused while it lasts.

---

## Token expiry

A token gets an expiry time when it is issued: now plus `token_expiry_days`. That time is stored with the token. Changing the setting later does not change tokens that already exist. It only sets the lifetime of tokens issued after the change.

A call with an expired token fails with `401`, the same as a missing, invalid or revoked token. Revoking a token takes effect right away.

---

## Forward timeout

When a tool call reaches your route, the package gives the request a context that ends after `forward_timeout_seconds`.

If that time passes before the route finishes:

- The context is cancelled, so any handler code watching `r.Context()` can stop.
- The agent gets a tool error with the code `timeout`.
- The call counts as a failure for the cooldown.

The package does not stop your handler by force. A handler that ignores `r.Context()` keeps running after the agent has been told the call timed out.

The same applies to anything in front of `/mcp`. A reverse proxy or server write timeout that is shorter than the forward timeout ends the connection before the package can answer.

---

## Response size

The package reads your route's response body and returns it to the agent as the tool result. It stops reading at `max_response_chars` characters. When the response is longer, the result is cut and ends with `[truncated]`.

The limit counts characters, not bytes, so a multi-byte character is never split in half.

---

## Concurrency

Two limits keep agent traffic from using up your server's capacity. Both are `Config` fields only. There are no settings rows for them, so they change on restart.

| Config field | Default | What it limits |
|---|---|---|
| `MaxConcurrentDB` | 10 | How many package database operations run at once: token checks, log writes, settings reads |
| `MaxConcurrentForwards` | 10 | How many tool calls run inside your router at once |

The two are counted separately. A full forward limit does not block a token check.

When all forward slots are busy, the next call waits for a slot. If its forward timeout runs out first, the agent gets a tool error with the code `rate_limited`, and the call does not count as a failure.

---

## Log cleanup

Every tool call writes one row to `mcp_logs`, including rejected ones. On a busy server this table keeps growing.

The package gives you a cleanup function for this. It is built to run as a **scheduled job**: you call it from your own job runner, such as a cron job, a ticker, or your app's scheduler, at an interval you choose. The package does not start a timer or run the job itself. That part belongs to your app.

```go
func (e *Engine) CleanupLogs(ctx context.Context) (LogCleanupResult, error)
```

Write a small job function that calls it, then register that function with your scheduler:

```go
func MCPLogCleanupJob(ctx context.Context) error {
    result, err := mcpEngine.CleanupLogs(ctx)
    if err != nil {
        return err
    }
    log.Printf("mcp log cleanup: deleted %d rows", result.Deleted)
    return nil
}
```

The function decides on its own whether there is anything to delete, so the job does not need any logic of its own. It can run as often as you like.

One call does this:

1. Counts the rows in `mcp_logs`.
2. If the count is at or below `log_cleanup_threshold`, it deletes nothing and returns `Deleted: 0`.
3. Otherwise it deletes the oldest `log_cleanup_batch` rows.

With the defaults, a table of 20,000 rows or fewer is left alone. At 20,001 rows, one call deletes the oldest 15,000, leaving 5,001.

A single call deletes at most one batch. If the table is far over the threshold, several calls are needed. Calling it when nothing is due is harmless.

`Engine.CleanupLogs` uses the limits of the engine you built, including your `Config` values and any settings rows. There is also a package-level `mcp.CleanupLogs(ctx, db)`. It builds its own store with the package defaults, so it ignores your `Config` values. It still reads the settings rows from the database.

---

## Server identity

`ServerName` and `ServerVersion` are sent to the MCP client when it connects. They do not affect the limits.

| Config field | Default |
|---|---|
| `ServerName` | `mcp` |
| `ServerVersion` | `1.0.0` |

```go
mcp.Config{
    ServerName:    "myapp",
    ServerVersion: "2.4.0",
}
```

---

## Other Config fields

| Config field | What it does |
|---|---|
| `AgentStore` | Required. Stores and finds agents in your own table |
| `Router` | The router tool calls are forwarded to. You can leave it empty and call `engine.SetRouter` later |
| `OnPanic` | Called with every panic the package recovers. When it is `nil`, the panic is logged with `log.Printf` |
| `Now` | A function that returns the current time. It exists so tests can control the clock |

---

## What's next

| Page | What you'll find |
|---|---|
| [Getting started](./index.md) | Setup and a first tool call |
| [Agents and tokens](./agents.md) | Creating agents, issuing tokens, and recognising an agent |
| [Tool calls](./calls.md) | The call flow, error codes, and the call log |
| [Publishing tools](./tools.md) | `AsMcpTool`, input structs, and where arguments go |
| [Reference](./reference.md) | Errors, tables, and the admin handler |
