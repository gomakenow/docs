---
title: Getting started
description: What MCP is, what the mcp package gives you, and five steps to run an MCP server that calls your routes.
---

# Getting started

<Badge type="tip" text="Requires migration" />

AI agents are becoming a normal way to run software. People ask an assistant to check open support tickets, look up recent errors, or reply to a customer. For that to work, the agent needs a safe way to reach your application. This package gives it one, without you writing a second API.

## What is MCP?

The Model Context Protocol (MCP) is an open standard for connecting AI agents to tools. A server publishes a list of tools, each with a name, a description, and a typed set of arguments. A client, such as Cursor or Claude, reads that list and lets the agent call the tools. The agent never touches your database directly. It sends a tool call, and the server does the work.

## Why it matters

Without MCP, you have two bad options:

- **Write a second API for agents.** Every feature is built twice. The two sets drift apart, and the agent path gets less testing.
- **Give the agent direct access.** Then the agent bypasses the checks your app already enforces.

The `mcp` package avoids both. It turns your existing HTTP routes into MCP tools:

- **One code path.** A tool call is forwarded, in process, to the same route a staff user calls. The handler, validation, and business logic run once, for both.
- **Your rules still decide.** The package does not decide who may act. The route keeps its own access check, and the package forwards the agent's token so that check sees the agent.
- **Every call is recorded.** Each tool call writes a log row. You can see what an agent asked for and what came back.
- **Misbehaving agents are contained.** After repeated failures, an agent is cooled down automatically. Its token can be revoked at any time.

## When to use it

Use the `mcp` package when you want an AI agent to act on your application in the same way a staff member does. Typical cases:

- Support staff ask an assistant to list, read, or reply to tickets
- An operations agent checks service health or recent errors
- An internal assistant answers questions from admin data
- An external tool, such as a coding assistant, works with your data through a controlled interface

Do not use it as a public API for end users. An agent is a machine with a static token. Keep MCP for trusted agents you control.

## What the package does not do

The package is host-agnostic. It has no imports from your application and no idea who your users are, what your data model looks like, or how you decide access. Your application supplies those things:

| The package provides | You provide |
|---|---|
| The `/mcp` endpoint and bearer token checks | The agent table and an `AgentStore` for it |
| Tool registration from a route and an input struct | The routes, handlers, and access checks behind each tool |
| Call logs, failure cooldown, token expiry, size limits | Admin screens or APIs to create agents and tokens |
| Tables and migrations for tokens, logs, and settings | The migration run and the database connection |

The package has three ideas:

- **Agents**: Machines that call your tools. An agent is not a user. It has its own static bearer token (`mcp_...`).
- **Tools**: Routes you publish with `AsMcpTool(...)`. The tool's method and path come from the route. Its arguments come from an input struct.
- **`engine.Handler()`**: The `/mcp` endpoint your agent connects to. It checks the token, writes a log row, and forwards the call.

In five steps, you run an MCP server and make one tool call.

---

## Step 1: Publish the migration

The package ships with SQL that creates four tables: tokens, logs, agent failures, and settings. Apply it:

```bash
make -C backend/mcp migrate-publish
make migrate-up
```

This creates `mcp_tokens`, `mcp_logs`, `mcp_agent_failures`, and `mcp_settings`. The package does not create the agents table. Your host owns that table (see Step 2).

---

## Step 2: Give the package an agent store

An agent is a row in a table you already own. The package does not know that table, so it asks for two methods through the `AgentStore` interface:

```go
type AgentStore interface {
    SaveAgent(ctx context.Context, agent Agent) error
    GetAgent(ctx context.Context, id string) (Agent, error)
}
```

- `SaveAgent` stores a new agent. It returns a duplicate error when the name is already taken
- `GetAgent` finds an agent by its id. It returns `ErrAgentNotFound` when no agent has that id

The package calls these methods when it needs an agent. Your code decides where the data lives. Implement the interface with your own table:

```go
type MachineStore struct {
    DB *gorm.DB
}

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

::: warning
`GetAgent` must return `mcp.ErrAgentNotFound` for an unknown id, as the example does. Without it, the package cannot tell "no such agent" from a database failure.
:::

The example uses `machines`. Use your own table name.

---

## Step 3: Create the engine

Call `mcp.New` once at startup, before you register routes:

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

r := mux.NewRouter()
r.Handle("/mcp", mcpEngine.Handler())

mcpEngine.SetRouter(r)
```

The engine takes:

| Part | What it does |
|---|---|
| `db` | Your `*gorm.DB`. `New` does not open a connection of its own |
| `AgentStore` | Required. Step 2 |
| `OnPanic` | Optional. Receives every panic the package recovers. When it is `nil`, the panic is logged with `log.Printf` |

`Handler()` is the `/mcp` endpoint. It checks the agent token on its own.

`SetRouter` tells the engine which router to forward tool calls to. Call it once the router exists, and before the server handles any tool call. The package does not import your router. You pass it in.

::: info Where /mcp sits
`/mcp` uses agent tokens, not user sessions, so it is registered outside your user-session middleware. A tool call can run for as long as the forward timeout, which is 90 seconds by default. A short write timeout, or a buffering proxy in front of `/mcp`, ends the connection before the call finishes.
:::

---

## Step 4: Publish a route and create an agent

Publish a route by calling the function `AsMcpTool` returns, with the route:

```go
type ListTicketsInput struct {
    Page int `json:"page,omitempty" jsonschema:"page number, starts at 1"`
}

route := r.Handle("/admin/tickets", requireTicketList(http.HandlerFunc(listTickets)))
route.Methods(http.MethodGet)

addTool := mcpEngine.AsMcpTool(mcp.Tool{
    Name:        "list_tickets",
    Description: "List support tickets",
    Input:       ListTicketsInput{},
})
addTool(route)
```

Here `requireTicketList` stands for the access check your app already puts on that route. `AsMcpTool` does not add one. It only publishes the route.

A tool call reaches the route through your router, so the route's own checks run on it. The agent's token proves who is calling, and the route decides whether that caller may act. A route with no access check accepts any valid agent token.

The [Publishing tools](./tools.md) page covers the tool definition in full.

Next, create an agent and its first token. [Agents and tokens](./agents.md) shows how, with the admin handler or with the engine's methods. The raw token is shown once, and the package stores only its SHA-256 hash.

How your routes recognise an agent, and what access it gets, is up to your app. The package does not manage that access. See [Agents and tokens](./agents.md#letting-your-routes-recognise-an-agent).

---

## Step 5: Connect a client and call a tool

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

To check the endpoint without a client, list the tools:

```bash
curl -s http://localhost:8003/mcp \
  -H "Authorization: Bearer mcp_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response lists every published tool. Call one with `tools/call`. Each call writes one row to `mcp_logs`, including rejected calls.

::: warning
A missing or invalid token returns `401`. A token that is expired or revoked also returns `401`. Issue a new token and update the client config.
:::

---

## That's it

You now have:
- An MCP endpoint at `/mcp` with bearer token auth
- A published route that an agent calls, gated by the same access check a staff user passes
- A log row for every call, with the raw token never stored
- Cooldown for an agent that keeps failing

As you grow, read:
- **Publishing tools**: See [Publishing tools](./tools.md) for naming, argument locations, and schema rules
- **Agents and tokens**: See [Agents and tokens](./agents.md) for the agent lifecycle and your auth middleware
- **Tool calls**: See [Tool calls](./calls.md) for the call flow, error codes, and logs
- **Configuration**: See [Configuration](./config.md) for limits, token expiry, and log cleanup
- **Reference**: See [Reference](./reference.md) for the admin handler, errors, and tables

---

## Next steps

| Page | For |
|---|---|
| [Publishing tools](./tools.md) | Publishing routes with `AsMcpTool`, argument tags, naming, `RegisterTool` |
| [Agents and tokens](./agents.md) | Creating agents, issuing and revoking tokens, and recognising an agent in your routes |
| [Tool calls](./calls.md) | What happens on a call, the errors an agent sees, and the call log |
| [Configuration](./config.md) | Settings, failure cooldown, token expiry, forward timeout, log cleanup |
| [Reference](./reference.md) | Sentinel errors, database tables, Make targets |
