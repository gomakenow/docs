---
title: Reference
description: Complete API reference for the MCP package.
---

# Reference

<Badge type="warning" text="Requires ACL" />

This page lists every public method, configuration field, admin route, error, and database table. For explanations and usage, see the other pages.

---

## Creating an engine

```go
engine, err := mcp.New(db, mcp.Config{
    AgentStore: MachineStore{DB: db},
})
```

`mcp.New` performs these steps:
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
    Router     http.Handler   // Optional; set later with Bind
    Now        func() time.Time

    MaxConcurrentDB       int // Default 10
    MaxConcurrentForwards int // Default 10
    ServerName            string // Default "mcp"
    ServerVersion         string // Default "1.0.0"
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

`SubjectTypeMachine` is the subject type the package uses for an agent (`"machine"`). Use it if your access system keys on subject type.

---

## Engine methods

| Method | Returns | Use |
|---|---|---|
| `Bind(parent *acl.Router)` | `*Router` | Attach the ACL router that tool calls are forwarded to. Call once, on the root |
| `Handler()` | `http.Handler` | The `/mcp` endpoint. Mount it outside user-session middleware |
| `AdminHandler()` | `http.Handler` | Package admin API. Mount it behind your own admin auth. The package does not check access here |
| `Authenticate(ctx, rawToken)` | `(Principal, error)` | Resolve a raw bearer token to its agent |
| `RegisterTool(spec Tool)` | `error` | Publish a tool that is not a route |
| `RegisterTools(tools []Tool)` | `error` | Register many tools. Skips names already registered |
| `CleanupLogs(ctx)` | `(LogCleanupResult, error)` | Delete the oldest log rows, when over the threshold |
| `ForgetAgent(ctx, id)` | `error` | Remove an agent's tokens and failure streak. Logs stay |

`Authenticate` returns a `Principal`. Its `AgentID` is the agent id.

### Router and Route

`Bind` returns a `*Router`, which wraps the ACL router. Gate routes with the ACL check as usual:

| Method | Notes |
|---|---|
| `HandleFunc`, `Handle`, `PathPrefix`, `NewRoute` | Create a route |
| `Methods`, `Path`, `Headers`, `Queries`, `Name`, `Handler`, `HandlerFunc`, `Subrouter` | Shape the route |
| `RequirePermission(perm)` | Gate the route with ACL. Chain before `AsMcpTool` |
| `AsMcpTool(spec Tool)` | Publish the route as a tool. Panics on a bad spec |

### Tool

```go
type Tool struct {
    Name        string // 1 to 128 characters: letters, digits, _, -, .
    Description string // Required
    Input       any    // Zero value of the request struct, or nil
    Method      string // Set by AsMcpTool; set it yourself with RegisterTool
    Route       string // Absolute path; set by AsMcpTool; set it yourself with RegisterTool
}
```

---

## Panic handling

```go
type Panic struct {
    Value    any
    Stack    string
    Source   string // PanicSourceHTTP, PanicSourceTool, or PanicSourceForward
    ToolName string
}
```

`p.Err()` returns the panic value as an `error`. Use it to send the panic to your error tracker.

---

## Admin routes

`AdminHandler()` serves these paths relative to the prefix your host mounts it at. The host chooses the prefix. The package does not check access, so mount it behind your own admin auth.

Creating an agent issues a token named `default`. A secret is returned once, when it is created.

| Method | Path | Notes |
|---|---|---|
| POST | `/agents` | Create an agent. Response includes the token secret once |
| GET | `/agents/{id}` | One agent |
| POST | `/agents/{id}/tokens` | Create a token. Response includes the secret once |
| GET | `/agents/{id}/tokens` | List tokens. No secrets |
| DELETE | `/agents/{id}/tokens/{tokenID}` | Revoke a token |
| GET | `/settings` | Effective settings |
| PUT | `/settings/{key}` | Body `{"value": 7}` |
| GET | `/logs` | Tool call log |

Your host usually adds routes the package does not provide, such as listing agents and deleting one. For deleting, call `ForgetAgent` and then remove the agent from your own table. Logs stay.

---

## Sentinel errors

| Error | Meaning |
|---|---|
| `ErrNilDB` | `New` called with a nil database |
| `ErrNilAgentStore` | `New` called without an `AgentStore` |
| `ErrNilEngine` | A method called on a nil engine |
| `ErrNilRouter` | The router passed to `Bind` is nil |
| `ErrAgentNotFound` | `GetAgent` has no agent with that id. Return this from your store |
| `ErrAgentExists` | An agent with that name already exists |
| `ErrEmptyName`, `ErrInvalidName`, `ErrInvalidDescription` | Agent or token input is not valid |
| `ErrTokenNotFound`, `ErrTokenExists` | Token lookup or creation failed |
| `ErrMissingToken` | No bearer token was sent. Returns `401` |
| `ErrInvalidToken` | The token does not match any stored hash. Returns `401` |
| `ErrExpiredToken` | The token is past its expiry. Returns `401` |
| `ErrRevokedToken` | The token was revoked. Returns `401` |
| `ErrUnknownSetting` | The settings key does not exist |
| `ErrInvalidSetting` | The settings value is out of range |
| `ErrDuplicateTool` | A tool name is already registered |
| `ErrInvalidTool` | A tool spec is not valid, such as a bad tag or a non-object input |
| `ErrInvalidRoute` | `AsMcpTool` needs one method and an absolute path |

Import these from `mcp` (for example `mcp.ErrAgentNotFound`). The package re-exports them, so the host does not import the internal errors package.

---

## Database tables

The migration creates four tables. The agents table is not one of them. Your host owns it.

| Table | Purpose |
|---|---|
| `mcp_tokens` | Static agent tokens. Stores only the SHA-256 hash |
| `mcp_logs` | One row per tool call, including reads and cooldown rejections |
| `mcp_agent_failures` | Failure streak per agent, for the cooldown |
| `mcp_settings` | Key/value overrides for the settings in [Configuration](./config.md) |

The raw token and full request bodies are never stored in `mcp_logs`. Password-like fields in the argument summary are redacted.

---

## Make targets

| Command | What it does |
|---|---|
| `make -C backend/mcp migrate-publish` | Copy the package migrations into `db/migrations` |
| `make migrate-up` | Apply migrations to the host database |
| `make -C backend/mcp test-mcp` | Run package tests on SQLite. No host database needed |
| `make -C backend/mcp test-mcp TestName` | Run one root test |
| `make -C backend/mcp mcp-migrate-new MIGRATION_NAME=name` | Create empty migration stubs in `mcp/migrations` |

---

## Next steps

| Page | For |
|---|---|
| [Getting started](./index.md) | Setup and first tool call |
| [Publishing tools](./tools.md) | Routes, argument tags, naming |
| [Configuration](./config.md) | Settings, cooldown, cleanup |
