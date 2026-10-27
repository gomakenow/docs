---
title: Reference
description: Complete API reference for the MCP package.
---

# Reference

This page lists the public methods, config fields, admin handler routes, errors, and database tables. For explanations and usage, see the other pages.

---

## Creating an engine

```go
engine, err := mcp.New(db, mcp.Config{
    AgentStore: MachineStore{DB: db},
})
```

`mcp.New`:
1. Returns `ErrNilDB` if `db` is nil
2. Returns `ErrNilAgentStore` if `AgentStore` is nil
3. Applies configuration defaults
4. Reads `mcp_settings` once to check that the tables exist

The package does not open its own database connection.

---

## Config

```go
type Config struct {
    AgentStore AgentStore     // Required
    Router     http.Handler   // Optional; set later with SetRouter
    Now        func() time.Time

    MaxConcurrentDB       int         // Default 10
    MaxConcurrentForwards int         // Default 10
    ServerName            string      // Default "mcp"
    ServerVersion         string      // Default "1.0.0"
    OnPanic               PanicLogger // Nil logs with log.Printf

    MaxConsecutiveFailures int           // Default 5
    FailureCooldown        time.Duration // Default 90s
    MaxResponseChars       int           // Default 50000
    TokenExpiry            time.Duration // Default 90 days
    ForwardTimeout         time.Duration // Default 90s
    LogCleanupBatch        int           // Default 15000
    LogCleanupThreshold    int           // Default 20000
}
```

See [Configuration](./config.md) for what each field does.

---

## AgentStore interface

```go
type AgentStore interface {
    SaveAgent(ctx context.Context, agent Agent) error
    GetAgent(ctx context.Context, id string) (Agent, error)
}
```

- `GetAgent` returns `ErrAgentNotFound` for an unknown id
- `SaveAgent` returns a duplicate-key error when the name is taken

---

## Models

### Agent

```go
type Agent struct {
    ID          string
    Name        string
    Description string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

The host owns where agents are stored. The package keeps only the string `ID`.

### Token

```go
type Token struct {
    ID         string
    AgentID    string
    Name       string
    ExpiresAt  time.Time
    LastUsedAt *time.Time
    RevokedAt  *time.Time
    CreatedAt  time.Time
}
```

The token hash is stored, never the secret. The raw secret is returned once, in `IssuedToken`.

### Log

One row per tool call from a known agent. It holds the agent and token ids, the tool name, the method and route, the status and status code, the duration in milliseconds, the request id, a short argument summary, and a short error summary. It never holds the bearer token or a full request body. See [Tool calls](./calls.md#the-call-log).

### Principal

The agent and token that a valid bearer token resolved to: `AgentID`, `TokenID`, `AgentName`, `TokenName`. See [Agents and tokens](./agents.md#letting-your-routes-recognise-an-agent).

### Panic

What `OnPanic` receives: `Value`, `Stack`, `Source` and `ToolName`. `Err()` formats them as one error. `Source` is one of `PanicSourceHTTP`, `PanicSourceTool` and `PanicSourceForward`. See [Tool calls](./calls.md#panics).

### ToolError

The JSON object an agent gets for a failed call: `code`, `message`, `retry_after_seconds` (optional) and `hint`. The codes are `validation`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `cooldown`, `timeout` and `internal`. See [Tool calls](./calls.md#error-codes).

### Constants

| Constant | Value |
|---|---|
| `SubjectTypeMachine` | `"machine"`. The subject type for an agent in an access system |
| `StatusSuccess`, `StatusFailed`, `StatusBlocked`, `StatusRateLimited` | The values of a log row's `status` |
| `KeyMaxConsecutiveFailures`, `KeyFailureCooldownSeconds`, `KeyMaxResponseChars`, `KeyTokenExpiryDays`, `KeyForwardTimeoutSeconds`, `KeyLogCleanupBatch`, `KeyLogCleanupThreshold` | The settings keys |
| `Default...` for each limit | The default values, such as `DefaultFailureCooldown` |

---

## Engine methods

### Setup

| Method | Purpose |
|---|---|
| `mcp.New(db, cfg) (*Engine, error)` | Build the engine |
| `SetRouter(http.Handler)` | Set the router tool calls are forwarded to |
| `Handler() http.Handler` | The `/mcp` endpoint. Checks the agent token itself |
| `AdminHandler() http.Handler` | Agent, token, setting, and log routes. Mount behind your admin auth |

### Tools

| Method | Purpose |
|---|---|
| `AsMcpTool(spec Tool) func(*mux.Route)` | Returns a function that publishes the route you give it. Panics on a bad spec |
| `RegisterTool(spec Tool) error` | Publish a tool that is not a route |
| `RegisterTools(tools []Tool) error` | Register a slice of tools |

### Agents and tokens

| Method | Purpose |
|---|---|
| `CreateAgent(ctx, name, description) (Agent, error)` | Create an agent |
| `GetAgent(ctx, id) (Agent, error)` | Read an agent |
| `ForgetAgent(ctx, id) error` | Remove an agent's tokens and failure streak. Log rows stay |
| `CreateToken(ctx, agentID, name) (IssuedToken, error)` | Issue a token. The secret is returned once |
| `RotateToken(ctx, agentID, name) (IssuedToken, error)` | Delete every token for the agent, then issue one named `name` |
| `CurrentToken(ctx, agentID) (*Token, error)` | Read the agent's current token |
| `RevokeToken(ctx, agentID, tokenID) error` | Revoke a token. It returns `401` at once |
| `DeleteToken(ctx, agentID, tokenID) error` | Delete a token row |
| `Authenticate(ctx, rawToken) (Principal, error)` | Resolve a raw bearer token to its agent |

### Settings and logs

| Method | Purpose |
|---|---|
| `Settings(ctx) (Settings, error)` | Effective limits: code defaults with settings rows applied |
| `PutSetting(ctx, key, value int) (Settings, error)` | Write one numeric override and return the effective limits |
| `CleanupLogs(ctx) (LogCleanupResult, error)` | Delete the oldest log rows when over the threshold |

`LogCleanupResult` has one field, `Deleted int`.

---

## Admin handler routes

`AdminHandler()` serves these routes. The paths are relative to the mount point. The handler does not check access. Your host must mount it behind its own admin authentication and access checks.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agents` | Create an agent. Body `{name, description}`. Returns `201` and the agent. No token is issued |
| `GET` | `/agents/{id}` | Read an agent |
| `POST` | `/agents/{id}/tokens` | Issue a token. Body `{name}`. Returns `201`, the token row, and the secret under `token` |
| `GET` | `/agents/{id}/tokens` | List an agent's tokens. No hash or secret |
| `DELETE` | `/agents/{id}/tokens/{tokenID}` | Revoke a token. Returns `204` |
| `GET` | `/settings` | Read effective settings |
| `PUT` | `/settings/{key}` | Write one setting. Body `{"value": 7}`. Returns the effective settings |
| `GET` | `/logs` | List call logs, newest first. Query `agent_id` and `limit` (default 50, most 100) |

A request body that has unknown fields, extra data, or is larger than 1 MB gets `400`. Errors are JSON, `{"code": "...", "message": "..."}`. The codes are `validation` (`400`), `not_found` (`404`), `conflict` (`409`) and `internal` (`500`). See [Agents and tokens](./agents.md) for how these routes are used.
Your host can also use the engine methods directly and expose its own routes. Both are valid.

---

## Errors

| Error | Meaning |
|---|---|
| `ErrNilDB` | `db` is nil in `New` |
| `ErrNilEngine` | Engine is nil |
| `ErrNilRouter` | Router is nil |
| `ErrNilAgentStore` | `AgentStore` is nil in `New` |
| `ErrEmptyName` | Name is empty |
| `ErrInvalidName` | Name is invalid |
| `ErrInvalidDescription` | Description is invalid |
| `ErrAgentNotFound` | Agent does not exist. Return this from `GetAgent` |
| `ErrAgentExists` | Agent name is taken |
| `ErrTokenNotFound` | Token does not exist |
| `ErrTokenExists` | Token name is taken for this agent |
| `ErrMissingToken` | No bearer token was sent. Returns `401` |
| `ErrInvalidToken` | Bearer token does not match. Returns `401` |
| `ErrExpiredToken` | Token is past `ExpiresAt`. Returns `401` |
| `ErrRevokedToken` | Token was revoked. Returns `401` |
| `ErrUnknownSetting` | Settings key does not exist |
| `ErrInvalidSetting` | Settings value is not allowed |
| `ErrDuplicateTool` | Tool name is already registered |
| `ErrInvalidTool` | Tool spec is invalid |
| `ErrInvalidRoute` | Route is not one method on an absolute path, or its tags do not match |

---

## Tool call statuses

Every call writes a log row with one of these statuses:

| Status | Meaning | Counts toward cooldown |
|---|---|---|
| `success` | The route returned success | Clears the streak |
| `failed` | The route or the call failed | Yes |
| `blocked` | The agent is in cooldown | No |
| `rate_limited` | The call was refused by a limit | No |

---

## Database tables

| Table | Holds |
|---|---|
| `mcp_tokens` | Token rows. Hash only, never the secret |
| `mcp_logs` | One row per tool call |
| `mcp_agent_failures` | Failure streak and cooldown deadline per agent |
| `mcp_settings` | Settings overrides |

The package does not create the agents table. Your host owns it.

---

## Make targets

Run from the repository root:

| Command | Purpose |
|---|---|
| `make -C backend/mcp test-mcp` | Run all package tests on SQLite |
| `make -C backend/mcp test-mcp TestName` | Run one test |
| `make -C backend/mcp mcp-migrate-new MIGRATION_NAME=name` | Create migration stubs in `backend/mcp/migrations` |
| `make -C backend/mcp migrate-publish` | Copy package migrations into the app's `db/migrations` |

---

## Next steps

| Page | For |
|---|---|
| [Getting started](./index.md) | Setup and first tool call |
| [Publishing tools](./tools.md) | Routes, argument tags, naming |
| [Agents and tokens](./agents.md) | Agent lifecycle, tokens, and recognising an agent |
| [Tool calls](./calls.md) | Call flow, error codes, call log, panics |
| [Configuration](./config.md) | Limits, cooldown, token expiry, cleanup |
