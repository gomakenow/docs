---
title: Getting started
description: Why MCP matters, what the mcp package gives you, and five steps to run an MCP server that calls your routes.
---

# Getting started

<Badge type="tip" text="Requires migration" />
<Badge type="warning" text="Requires ACL" />

::: warning Requires the ACL package
The `mcp` package must be set up with the [`acl`](../acl/) package. `Bind` takes the ACL router, and every published route is gated with the ACL check. Set up `acl` first, then follow this page.
:::

AI agents are becoming a normal way to run software. People ask an assistant to check open support tickets, look up last week's revenue, or reply to a customer. For that to work, the agent needs a safe way to reach your application. This package gives it one, without you writing a second API.

## What is MCP?

The Model Context Protocol (MCP) is an open standard for connecting AI agents to tools. A server publishes a list of tools, each with a name, a description, and a typed set of arguments. A client, such as Cursor or Claude, reads that list and lets the agent call the tools. The agent never touches your database directly. It sends a tool call, and the server does the work.

## Why it matters

Without MCP, you have two bad options:

- **Write a second API for agents.** Every feature is built twice. The two sets drift apart, and the agent path gets less testing.
- **Give the agent direct access.** Then the agent bypasses the checks your app already enforces.

The `mcp` package avoids both. It turns your existing HTTP routes into MCP tools:

- **One code path.** A tool call is forwarded, in process, to the same route a staff user calls. The route's handler, validation, and business logic run once, for both.
- **Your access rules still decide.** Each published route keeps its ACL check. The package forwards the agent's token, and the route decides what that identity may do.
- **Every call is recorded.** Each tool call writes a log row. You can see what an agent asked for and what came back.
- **Misbehaving agents are contained.** After repeated failures, an agent is cooled down automatically. Its token can be revoked at any time.

## When to use it

Use the `mcp` package when you want an AI agent to act on your application in the same way a staff member does. Typical cases:

- Support staff ask an assistant to list, read, or reply to tickets
- An operations agent checks service health or recent errors
- An internal assistant answers questions from admin data
- An external tool, such as a coding assistant, works with your data through a controlled interface

Do not use it as a public API for end users. An agent is a machine with a static token, and its access is set by the access rules your app applies to it. Keep MCP for trusted agents you control.

## What you get

- An MCP endpoint at `/mcp`, with bearer token auth for each agent
- An admin API to create agents, issue and revoke tokens, and change limits
- A way to publish any route as a tool with one chained call, `.AsMcpTool`
- Failure cooldown, token expiry, response size limits, and forward timeouts
- A call log with redaction, plus a cleanup job for old rows
- Tests that run on SQLite, without your host database

The package is host-agnostic. It does not know about your users, your data model, or your access rules. Your application supplies those. The one exception is the ACL package, which the router binding requires.

The package has three ideas:

- **Agents** — Machines that call your tools. An agent is not a user. It has its own static bearer token (`mcp_...`).
- **Tools** — Routes you publish with `.AsMcpTool(...)`. The tool name, arguments, and schema come from the route and its input struct.
- **`engine.Handler()`** — The `/mcp` endpoint your agent connects to. It checks the token, writes a log row, and forwards the call.

In five steps, you run an MCP server and make one tool call.

---

## Step 1 — Publish the migration

The package ships with SQL that creates four tables: tokens, logs, agent failures, and settings. Apply it:

```bash
make -C backend/mcp migrate-publish
make migrate-up
```

This creates `mcp_tokens`, `mcp_logs`, `mcp_agent_failures`, and `mcp_settings`. The package does not create the agents table. Your host owns that table (see Step 2).

---

## Step 2 — Give the package an agent store

An agent is a row in a table you already own. The package only needs two methods to save and find one. Implement `AgentStore`:

```go
type MachineStore struct {
    DB *gorm.DB
}

// Use your own table name. GORM would otherwise guess "agents".
func (s MachineStore) SaveAgent(ctx context.Context, a mcp.Agent) error {
    return s.DB.WithContext(ctx).Table("machines").Create(&a).Error
}

func (s MachineStore) GetAgent(ctx context.Context, id string) (mcp.Agent, error) {
    var a mcp.Agent
    err := s.DB.WithContext(ctx).Table("machines").First(&a, "id = ?", id).Error
    if errors.Is(err, gorm.ErrRecordNotFound) {
        return mcp.Agent{}, mcp.ErrAgentNotFound
    }
    return a, err
}
```

`GetAgent` must return `mcp.ErrAgentNotFound` for an unknown id. `SaveAgent` must return a duplicate-key error when the name is taken.

::: info
The `mcp` package does not know about users or your data model. Agent identity lives in a table your app owns. The example uses `machines`; use your own table name.
:::

---

## Step 3 — Create the engine

Set up the ACL engine first, then call `mcp.New` once at startup. Create the MCP engine, then bind it to the ACL router:

```go
mcpEngine, err := mcp.New(db, mcp.Config{
    AgentStore: MachineStore{DB: db},
    OnPanic: func(p mcp.Panic) {
        log.Printf("mcp panic: %v", p.Err())
    },
})
if err != nil {
    log.Fatalf("mcp engine: %v", err)
}

r := mcpEngine.Bind(aclEngine.Bind(mux.NewRouter()))
r.Handle("/mcp", mcpEngine.Handler())
```

The engine takes:
- A database connection. `New` does not open its own
- `AgentStore` — Required. Step 2
- `OnPanic` — Optional. Receives every recovered panic. Nil logs with `log.Printf`

`Bind` attaches the ACL router. Tool calls are forwarded to that router, so the ACL check on the target route runs. Call `Bind` once, on the root router, before you add routes.

::: warning
Mount `/mcp` outside your user-session middleware. The package checks the agent token itself. Do not put a short write timeout or a buffering proxy in front of `/mcp`. The forward timeout defaults to 90 seconds.
:::

---

## Step 4 — Publish a route and create an agent

Publish one route as a tool. Put the route's ACL check before `AsMcpTool`:

```go
type ListTicketsInput struct {
    Page int `json:"page,omitempty" jsonschema:"page number, starts at 1"`
}

r.HandleFunc("/admin/tickets", listTickets).
    Methods(http.MethodGet).
    RequirePermission(acl.TicketList).
    AsMcpTool(mcp.Tool{
        Name:        "list_tickets",
        Description: "List support tickets",
        Input:       ListTicketsInput{},
    })
```

`AsMcpTool` does not add an access check. The `RequirePermission` check on the route does. Keep it on every route you publish. An agent token proves who is calling. The route decides whether that identity may act.

::: warning
Do not publish a route that has no access check. Any valid agent token would reach it.
:::

Read the [Publishing tools](./tools.md) page before you publish more routes.

Create the agent through your admin API or your own admin screen. Creating an agent issues a token named `default`. The raw token is returned once. Copy it now. The package stores only its SHA-256 hash.

Then give the agent the access your ACL setup grants to machine identities, in the same way you grant access to a service account. The package does not manage that access.

---

## Step 5 — Connect a client and call a tool

Point your MCP client at `/mcp` and send the token as a bearer header. For Cursor, add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "myapp": {
      "url": "http://localhost:8003/mcp",
      "headers": {
        "Authorization": "Bearer mcp_YOUR_TOKEN"
      }
    }
  }
}
```

Replace `localhost:8003` with your server's address and `mcp_YOUR_TOKEN` with the token from Step 4.

To check the endpoint without a client, send the MCP handshake and list the tools:

```bash
curl -s http://localhost:8003/mcp \
  -H "Authorization: Bearer mcp_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists every published tool. Call one with `tools/call`, then read the call log (`mcp_logs`) through your admin API. Each call writes one row, including rejected calls.

::: warning
A missing or invalid token returns `401`. A token that is expired or revoked also returns `401`. Issue a new token through your admin API and update the client config.
:::

---

## That's it

You now have:
- An MCP endpoint at `/mcp` with bearer token auth
- A published route that an agent calls, gated by the same ACL check a staff user passes
- A log row for every call, with the token and full bodies never stored
- Cooldown for an agent that keeps failing

As you grow, read:
- **Publishing tools** — See [Publishing tools](./tools.md) for naming, argument locations, and schema rules
- **Configuration** — See [Configuration](./config.md) for limits, token expiry, and log cleanup
- **Reference** — See [Reference](./reference.md) for admin routes, errors, and tables

---

## Next steps

| Page | For |
|---|---|
| [Publishing tools](./tools.md) | Publishing routes with `AsMcpTool`, argument tags, naming, `RegisterTool` |
| [Configuration](./config.md) | Settings, failure cooldown, token expiry, forward timeout, log cleanup |
| [Reference](./reference.md) | Admin routes, sentinel errors, database tables, Make targets |
