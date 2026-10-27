---
title: Publishing tools
description: How AsMcpTool turns a route into a tool, how its arguments reach your handler, and the rules a tool must follow.
---

# Publishing tools

A tool is a route. You do not write a second handler for the agent. When you publish a route, the package reads its method and path, builds a description of its arguments from a struct, and shows both to the agent. When the agent calls the tool, the package turns the arguments into an ordinary HTTP request and sends it to that same route, inside your server.

```go
r := mux.NewRouter()

route := r.HandleFunc("/admin/tickets", listTickets)
route.Methods(http.MethodGet)

addTool := mcpEngine.AsMcpTool(mcp.Tool{
    Name:        "list_tickets",
    Description: "List support tickets",
    Input:       ListTicketsInput{},
})
addTool(route)
```

This page covers what `AsMcpTool` reads, how arguments are placed on the request, and what makes a tool invalid.

---

## What AsMcpTool does

```go
func (e *Engine) AsMcpTool(spec Tool) func(*mux.Route)
```

`AsMcpTool` returns a function that takes a `*mux.Route`. You call that function with the route once, while the server is starting.

When you call it, it:

1. Reads the route's **method** and **path**.
2. Checks the `Input` struct and builds the argument schema from it.
3. Registers the tool under its `Name`.

`AsMcpTool` does not touch the route's handler. It does not add an access check either. Your route keeps whatever middleware and checks it already has, and those run on every tool call because the call is forwarded through your router.

### What it needs from the route

| From the route | Rule |
|---|---|
| Method | Exactly one, and it must be `GET`, `HEAD`, `DELETE`, `POST`, `PUT` or `PATCH` |
| Path | An absolute path starting with `/`, with no `?` in it. Path parameters like `{id}` are fine |

The function `AsMcpTool` returns has no error result. When the tool is not valid, it **panics**, and the message names the tool. This happens at startup, so a bad tool stops the server from booting. It never turns into a failed call later.

The method has to be set on the route before you call the function, because that is when the package reads it.

---

## The tool

`mcp.Tool` has three fields you fill in for `AsMcpTool`:

| Field | What it is | Rules |
|---|---|---|
| `Name` | The name the agent sees | 1 to 128 characters. Letters, digits, `_`, `-` and `.` only. Must be unique |
| `Description` | What the tool does, in words the agent reads | Required. Cannot be blank |
| `Input` | A value of the struct that describes the arguments | `nil` means the tool takes no arguments |

Two tools with the same name are not allowed. The second registration panics.

`Input` is a value, not a type. Pass `ListTicketsInput{}`, or a pointer to one, and the package reads its type.

```go
mcp.Tool{Name: "get_stats", Description: "Get dashboard stats", Input: nil}
```

---

## The input struct

The struct describes the arguments the agent can send. Each exported field becomes one argument.

```go
type ListTicketsInput struct {
    Status string `json:"status,omitempty" jsonschema:"open, closed, or all"`
    Page   int    `json:"page" jsonschema:"page number, starts at 1"`
}
```

| Part | What it does |
|---|---|
| `json:"name"` | The argument's name. It is also the key your handler sees |
| `json:"name,omitempty"` | Makes the argument optional |
| `json:"-"` | Leaves the field out |
| `jsonschema:"..."` | The description the agent reads for this argument |
| `mcp:"..."` | Where the argument goes on the request. See the next section |

A field without `omitempty` is **required**: the call is rejected before it reaches your route if the argument is missing. In the example, `page` is required and `status` is optional.

The `jsonschema` tag is one plain sentence, not a list of options. The whole tag is the description, so write the real accepted values into it, such as `open, closed, or all`.

A few rules apply to the struct:

- Embedded (anonymous) fields are not supported.
- Two fields cannot share one `json` name.
- A `jsonschema` tag cannot be empty.
- A `jsonschema` tag cannot start with `word=`, such as `disabled=true`. The schema library reads that as a setting and fails.
- The struct has to describe an object. Nested structs are allowed.

When any of these is broken, `AsMcpTool` panics at startup.

### Missing and empty arguments

The package keeps the arguments the way the agent sent them:

| The agent sends | Your handler receives |
|---|---|
| The key left out | No key |
| `"status": ""` | The key, with an empty string |

If your handler decodes into a plain `string` field, both cases look empty. A pointer field (`*string`) tells them apart: `nil` for a missing key, a pointer to `""` for an empty one.

---

## Where each argument goes

The package builds one HTTP request from the arguments. The `mcp` tag decides which part of the request each field lands in. Without a tag, the package picks a place:

| Field | Where it goes |
|---|---|
| Name matches a `{placeholder}` in the path | The path |
| No tag, on a `GET`, `HEAD` or `DELETE` route | The query string |
| No tag, on a `POST`, `PUT` or `PATCH` route | The JSON body |

The tag overrides that choice:

| `mcp` tag | Where the field goes |
|---|---|
| `path` | The path |
| `query` | The query string |
| `body` | The JSON body |
| `body:wireName` | The JSON body, under the key `wireName` |
| `body-root` | The whole JSON body |

Here is a route with all three places in use:

```go
type ReplyTicketInput struct {
    ID      string `json:"id" jsonschema:"ticket id"`
    Notify  bool   `json:"notify,omitempty" mcp:"query" jsonschema:"email the customer"`
    Content string `json:"content" jsonschema:"reply text"`
}

r := mux.NewRouter()

route := r.HandleFunc("/admin/tickets/{id}/reply", replyTicket)
route.Methods(http.MethodPost)

addTool := mcpEngine.AsMcpTool(mcp.Tool{
    Name:        "reply_ticket",
    Description: "Reply to a support ticket",
    Input:       ReplyTicketInput{},
})
addTool(route)
```

When an agent calls `reply_ticket` with `id` `42`, `notify` `true`, and `content` `Thanks`, the forwarded request is:

```
POST /admin/tickets/42/reply?notify=true
Content-Type: application/json

{"content": "Thanks"}
```

### Path fields

A field whose `json` name matches a `{placeholder}` goes in the path. The match is by name, so `{id}` needs a field named `id`.

The two sides have to agree, in both directions:

- A field tagged `path` must have a matching `{placeholder}` in the route.
- A `{placeholder}` in the route must belong to a field. A field that is placed anywhere else is rejected.

The value is escaped before it goes in the URL. A call with an empty or missing path value fails with an error.

### Query fields

Each query field becomes `?name=value`. An empty string is left out. A list becomes the same key repeated: `?tag=a&tag=b`.

### Body fields

Body fields are collected into one JSON object. `body:wireName` renames the key in that object, so your handler can use a different JSON name than the tool does.

A `POST`, `PUT` or `PATCH` call with no body fields still sends `{}` as its body, so a handler that always decodes a body gets valid JSON.

`body-root` makes one field the entire body. It is for a route whose body is a list or a single value instead of an object. It cannot be combined with any other body field.

---

## What your handler sees

Every tool call reaches your handler as a normal request. The package sets:

- `Authorization: Bearer <the agent's token>`, the same token the agent used on `/mcp`
- `X-Request-ID`
- `Content-Type: application/json`, when there is a body
- `Accept: application/json`
- A request context with the forward timeout on it

The handler runs the way it does for a browser: the same middleware, the same checks, the same code. The only differences are the two things above: the caller is an agent identified by its token, and the request must be one the package can build.

That second part limits which routes can be tools:

| Route behavior | Works as a tool |
|---|---|
| Reads JSON or a query string | Yes |
| Reads only multipart form fields | No. The package sends no multipart body |
| Needs a logged-in user object and has no path for a machine | No. The agent is a machine, not a user |

When the context is cancelled, the forward timeout has passed. A handler that watches `r.Context()` stops its work then, including database queries.

---

## RegisterTool

`RegisterTool` publishes a tool that has no route behind it. You give it the method and path yourself, and it returns an error instead of panicking:

```go
err := mcpEngine.RegisterTool(mcp.Tool{
    Name:        "get_build_info",
    Description: "Return the build version",
    Input:       nil,
    Method:      http.MethodGet,
    Route:       "/admin/build-info",
})
if err != nil {
    log.Fatal(err)
}
```

`RegisterTools` takes a slice. It skips a name that is already registered and stops at any other error. Tools registered before that error stay registered.

`AsMcpTool` is `RegisterTool` with the method and path read from the route.

---

## How the agent sees your tool

The agent gets the list of tools from `tools/list`. Each entry has the name, the description and a schema built from your input struct. Tools on `GET` and `HEAD` routes are marked read-only.

The list is whatever the running process registered. It does not change until the server restarts with new code.

---

## Testing a tool

A tool is a route, so the handler is tested the way any handler is, by calling it directly. The schema is built when the tool is registered, so a bad struct shows up as a panic in any test that declares the route.

To check the schema on its own, build it from the struct with `jsonschema.ForType`. The package's own tests run on SQLite and do not need your database:

```bash
make -C backend/mcp test-mcp
```

---

## What's next

| Page | What you'll find |
|---|---|
| [Getting started](./index.md) | Setup and a first tool call |
| [Agents and tokens](./agents.md) | Creating agents and recognising them in your routes |
| [Tool calls](./calls.md) | What the agent sees, error codes, and the call log |
| [Configuration](./config.md) | Settings, cooldown, token expiry, log cleanup |
| [Reference](./reference.md) | Errors, tables, and the admin handler |
