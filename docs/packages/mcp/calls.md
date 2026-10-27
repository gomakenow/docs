---
title: Tool calls
description: What happens when an agent calls a tool, what the agent gets back on success and failure, and what the call log records.
---

# Tool calls

This page follows one tool call from the agent to your route and back. It covers what the agent receives, the error codes, the call log, and how panics are handled.

---

## Listing the tools

An MCP client starts by asking for the list of tools with `tools/list`. The package answers with every tool you registered, in one response. Each entry has the tool's name, its description, and the argument schema built from your input struct.

A tool on a `GET` or `HEAD` route is marked **read-only**, so clients can tell it does not change anything.

The list is whatever the running process registered. It changes only when the server restarts with different code.

---

## The life of a call

When the agent sends `tools/call`, the package goes through these steps in order. The first step that fails ends the call.

| Step | Check | If it fails |
|---|---|---|
| 1 | The bearer token is valid. See [Agents and tokens](./agents.md#how-a-token-is-checked) | `unauthorized` |
| 2 | The agent is not in a cooldown | `cooldown` |
| 3 | The arguments match the tool's schema | `validation` |
| 4 | The arguments become an HTTP request. See [Publishing tools](./tools.md#where-each-argument-goes) | `validation` |
| 5 | A slot is free in the forward limit | `rate_limited` |
| 6 | The request is sent to your router, with the forward timeout | `timeout`, or the code for your route's answer |
| 7 | The response is read, up to `max_response_chars` | |

The token is checked twice. `/mcp` itself checks it first and answers a bad token with an HTTP `401` and a JSON body `{"code": "unauthorized", "message": "..."}`, before any tool runs. The tool handler checks it again, so a call that fails there comes back as an `unauthorized` tool error.

Each call ends with one of two results.

### Success

When your route answers with a `2xx` status, the agent gets the response body as the tool result. A body longer than `max_response_chars` is cut and ends with `[truncated]`.

### Failure

For anything else, the agent gets a tool result with `isError: true`. Its text is a JSON object:

```json
{
  "code": "cooldown",
  "message": "this agent is in a cooldown after repeated failures",
  "retry_after_seconds": 62,
  "hint": "Wait for the cooldown to finish, then retry."
}
```

| Field | Meaning |
|---|---|
| `code` | A short, fixed name for the kind of failure. See the table below |
| `message` | What went wrong. For a failure from your route, this is the `message` or `error` field of its JSON response, or the response text |
| `retry_after_seconds` | How long to wait before trying again. Only present for `cooldown`, and for `rate_limited` when your route sent a `Retry-After` header |
| `hint` | One sentence telling the agent what to do next |

The error text is cut at 500 characters.

### Error codes

| Code | Comes from |
|---|---|
| `unauthorized` | The token was rejected, or your route answered `401` |
| `forbidden` | Your route answered `403` |
| `not_found` | Your route answered `404` |
| `conflict` | Your route answered `409` |
| `validation` | The arguments do not match the schema, they could not be turned into a request, or your route answered `400` or `422` |
| `rate_limited` | Your route answered `429`, or all forward slots were busy |
| `cooldown` | The agent is blocked after repeated failures |
| `timeout` | The call ran past the forward timeout, or your route answered `504` |
| `internal` | Anything else: another `4xx` or `5xx` from your route, a panic, or a problem inside the package |

The package does not interpret your route's answer beyond its status code. Your route chooses the status, and the package turns it into the matching code.

---

## What counts as a failure

Each call changes the agent's failure streak, which drives the cooldown:

| Status in the log | Meaning | Effect on the streak |
|---|---|---|
| `success` | Your route answered `2xx` | Reset to 0 |
| `failed` | Any failure that is not listed below | Plus 1 |
| `blocked` | Refused because the agent is in cooldown | None |
| `rate_limited` | Your route answered `429`, or the forward limit was full | None |

See [Configuration](./config.md#failure-cooldown) for the numbers.

---

## The call log

A call from a known agent writes one row to `mcp_logs`, whatever its result. This includes calls that were refused for a cooldown or for bad arguments, and calls that timed out. A call with no valid token has no agent to attach a row to, so it is not logged.

| Column | What it holds |
|---|---|
| `id` | The log row's own id |
| `created_at` | When the call finished |
| `agent_id`, `token_id` | Who made the call, and with which token |
| `tool_name` | The tool called |
| `method`, `route` | The route the tool points at, such as `POST` `/admin/tickets/{id}/reply` |
| `status` | `success`, `failed`, `blocked` or `rate_limited` |
| `status_code` | The HTTP status of the call, such as `200`, `403`, or `504` for a timeout |
| `duration_ms` | How long the call took |
| `request_id` | The id sent to your route in the `X-Request-ID` header |
| `args_summary` | A short summary of the arguments |
| `error_summary` | The error message, when the call failed |

The `request_id` is the same one your route receives, so you can match a log row to your own server logs.

### What is never stored

The log has no raw token and no full request or response bodies. The argument summary is shortened and has sensitive values hidden:

- A field whose name contains `password`, `secret`, `authorization`, `api_key`, `apikey`, `credential`, `private_key`, `ssn` or `bearer` has its value replaced with `[redacted]`. So does a field named `token` or ending in `_token`. A field named `token_id` is kept.
- A string longer than 80 characters is cut to 40 characters and ends with `…`.
- The whole summary is cut at 500 characters.
- The raw token is removed from the summary if it appears in it.

### Reading the log

`GET /logs` on the admin handler returns the newest rows first:

```bash
curl "http://localhost:8003/admin/mcp/logs?agent_id=AGENT_ID&limit=20"
```

| Query parameter | Meaning |
|---|---|
| `agent_id` | Only rows for this agent. Leave it out for all agents |
| `limit` | How many rows. The default is 50 and the most is 100 |

The `mcp_logs` table grows with every call. See [Configuration](./config.md#log-cleanup) for the cleanup job.

---

## Panics

The package recovers a panic in three places, so a bug in one call does not take the server down:

| Source | Where it happened |
|---|---|
| `http` | In the `/mcp` or admin HTTP handling. The client gets `500` |
| `tool` | In the tool handler. The agent gets an `internal` error saying the tool panicked |
| `forward` | In your route's handler, while the package was forwarding the call. The agent gets an `internal` error, and the call counts as a failure |

Each recovered panic is passed to the `OnPanic` function you set in `mcp.Config`. It receives an `mcp.Panic`:

| Field | Meaning |
|---|---|
| `Value` | The value passed to `panic` |
| `Stack` | The stack trace |
| `Source` | `mcp.PanicSourceHTTP`, `mcp.PanicSourceTool` or `mcp.PanicSourceForward` |
| `ToolName` | The tool being called, when it is known |

`p.Err()` formats all of it as one error, ready to send to an error tracker:

```go
mcpEngine, err := mcp.New(db, mcp.Config{
    AgentStore: MachineStore{DB: db},
    OnPanic: func(p mcp.Panic) {
        reportToTracker(p.Err())
    },
})
```

When `OnPanic` is `nil`, the panic and its stack are written with `log.Printf`.

---

## What's next

| Page | What you'll find |
|---|---|
| [Agents and tokens](./agents.md) | Creating agents, issuing tokens, and recognising an agent in your routes |
| [Configuration](./config.md) | Cooldown, timeouts, response size, and log cleanup |
| [Reference](./reference.md) | Every method, error and table |
