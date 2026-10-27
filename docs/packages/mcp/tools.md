---
title: Publishing tools
description: Publish an existing route as an MCP tool, shape its arguments, and name it.
---

# Publishing tools

<Badge type="warning" text="Requires ACL" />

A tool is a route. You do not write a second handler for the agent. `AsMcpTool` reads the method and path from the route, reads the arguments from an input struct, and forwards each call to the route with the agent's token.

Publish only routes that enforce an ACL check. The agent's token alone does not decide what is allowed.

---

## Publish a route

Chain `.AsMcpTool` on the route, after `.Methods` and `.RequirePermission`:

```go
type ReplyTicketInput struct {
    ID      string `json:"id" jsonschema:"ticket id"`
    Content string `json:"content" jsonschema:"reply text"`
}

r.HandleFunc("/admin/tickets/{id}/reply", replyTicket).
    Methods(http.MethodPost).
    RequirePermission(acl.TicketReply).
    AsMcpTool(mcp.Tool{
        Name:        "reply_ticket",
        Description: "Reply to a support ticket",
        Input:       ReplyTicketInput{},
    })
```

The engine reads two things from the route:
- **Method** — Must be exactly one, such as `POST`
- **Path** — Must be absolute, such as `/admin/tickets/{id}/reply`

`AsMcpTool` does not add an access check. The `RequirePermission` check on the route does the gating. Chain it before `AsMcpTool`. The agent must hold that permission through its ACL setup, or the call is rejected.

::: warning
A bad route spec panics at startup. `AsMcpTool` cannot return an error, so the process will not boot with a bad spec. Fix the route and restart. The previous process keeps serving the old tool list until then.
:::

---

## Input struct

`Input` is a zero value of the request struct:

```go
Input: ReplyTicketInput{}
```

- `json` names are the argument names. The agent sends them, and they become the keys of the forwarded request
- `jsonschema` is the argument description. It is one string, not a list of options
- `Input: nil` means the tool takes no arguments

```go
mcp.Tool{Name: "get_stats", Description: "Get dashboard stats", Input: nil}
```

### Required and optional fields

A field without `omitempty` is required in the tool schema. The agent must send it.

```go
type ListTicketsInput struct {
    Status string `json:"status,omitempty" jsonschema:"open, closed, or all"`
    Page   int    `json:"page" jsonschema:"page number, starts at 1"`
}
```

Here `page` is required and `status` is optional.

Two rules to know:

- A missing key stays missing when the request is forwarded. An empty string is sent as `""`
- A handler that decodes into a plain string sees both as empty. Use a pointer when a missing field must not overwrite the stored value

Name the real accepted values in the description (`open, closed, or all`). Do not use an example the server rejects.

::: warning
The `jsonschema` tag must not start with `word=`, such as `disabled=true`. That makes schema generation fail, and the process will not boot. `required:` is fine. `key=value` at the start is not.
:::

---

## Argument locations

The `mcp` tag decides where a field goes on the forwarded request.

| `mcp` tag | Where the field goes |
|---|---|
| Omitted, and the name is a `{placeholder}` | Path |
| Omitted on GET, HEAD, DELETE | Query string |
| Omitted on POST, PUT, PATCH | JSON body |
| `path`, `query`, `body` | That location |
| `body:wireName` | JSON body under `wireName` |
| `body-root` | The whole JSON body. Only this field, no other body fields |

A path field must use the placeholder's name:

```go
type IDPath struct {
    ID string `json:"id" mcp:"path" jsonschema:"ticket id"`
}
```

Do not put a body field on a `{name}` that is not tagged `path`.

---

## Naming

Tool names come from the route. Use this pattern:

- `list_` for a GET collection, such as `list_tickets`
- `get_` for a GET of one item, such as `get_tickets_id`
- Otherwise the method (`post_`, `put_`, `patch_`, `delete_`), then the path segments joined with `_`
- `{id}` becomes `id`. Hyphens become underscores

If a nearby tool already breaks the pattern, match it. `reply_ticket` is an example.

Names may use letters, digits, `_`, `-`, and `.`. They may be 1 to 128 characters long. A duplicate name panics.

---

## Rules for the handler

The forwarder sends JSON or a query string. Keep the route compatible with that:

- Decode JSON request bodies. A handler that reads only multipart form fields will not see the tool body
- Prefer JSON for any route you publish
- Stop work when `r.Context()` is cancelled. That is how the forward timeout stops the database work
- Do not publish a route that returns a secret. Token creation returns its secret once, and another route that returns one is a leak

Do not publish a route only so an agent can do something your UI cannot. Publish routes that your own users already call through the same access checks.

::: info
If the handler records who acted, the agent is a machine identity, not a user. Decide how your app records machine actors before you publish the route.
:::

---

## RegisterTool

`RegisterTool` publishes a tool that is not a route. Use it rarely:

```go
err := mcpEngine.RegisterTool(mcp.Tool{
    Name:        "get_build_info",
    Description: "Return the build version",
    Input:       nil,
    Method:      http.MethodGet,
    Route:       "/admin/build-info",
})
```

`RegisterTool` returns errors instead of panicking. `RegisterTools` registers a slice and skips names that are already registered.

---

## Testing a tool

Handler tests call the handler directly. Add a schema test when a tag or a required field is easy to get wrong. The package tests run on SQLite and do not need your host database:

```bash
make -C backend/mcp test-mcp
```

After a tool change, the tool list the agent sees is the list the running process registered. Restarting the server refreshes it. Restarting only the MCP client does not compile your Go code.

---

## Next steps

| Page | For |
|---|---|
| [Getting started](./index.md) | Setup and first tool call |
| [Configuration](./config.md) | Settings, cooldown, cleanup |
| [Reference](./reference.md) | Sentinel errors and admin routes |
