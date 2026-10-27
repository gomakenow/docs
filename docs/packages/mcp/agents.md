---
title: Agents and tokens
description: How agents and their tokens are created, used, revoked and removed, and how your routes recognise an agent.
---

# Agents and tokens

An agent is a machine that calls your tools. It is not a user. It has no password and no session. It has one or more **tokens**, and each token is a long random string that the agent sends with every request.

The package splits the work like this:

| Who owns it | What |
|---|---|
| **Your app** | The `agents` table, through your `AgentStore`. You decide where agents live |
| **The package** | Tokens, call logs, and the failure streak, in its own tables. Each row refers to the agent by its `ID` string |

This page covers creating agents, issuing tokens, how a token is checked, and how your own routes recognise an agent when a tool call reaches them.

---

## Creating an agent

You can create an agent in two ways. Both end up calling your `AgentStore.SaveAgent`.

### With the engine

```go
agent, err := mcpEngine.CreateAgent(ctx, "support-bot", "Reads and replies to tickets")
if err != nil {
    return err
}
```

`CreateAgent` checks the name and description, gives the agent a new UUID as its `ID`, and saves it through your store.

| Field | Rule |
|---|---|
| `name` | Required. At most 255 characters. Must be unique in your store |
| `description` | Optional. At most 4000 characters |

The call fails with `ErrEmptyName`, `ErrInvalidName`, `ErrInvalidDescription`, or `ErrAgentExists` when the name is already taken.

`CreateAgent` does **not** issue a token. An agent with no token cannot call anything yet.

### With the admin handler

`engine.AdminHandler()` is a ready-made HTTP API for agents, tokens, settings and logs. It checks no access of its own, so you mount it behind your admin authentication. The paths are relative to the mount point:

```go
r := mux.NewRouter()

admin := http.StripPrefix("/admin/mcp", adminOnly(mcpEngine.AdminHandler()))
r.PathPrefix("/admin/mcp/").Handler(admin)
```

Here `adminOnly` stands for your own admin middleware. Then:

```bash
curl -X POST http://localhost:8003/admin/mcp/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "support-bot", "description": "Reads and replies to tickets"}'
```

The response is `201` with the agent as JSON. It has no token in it.

---

## Issuing a token

```go
issued, err := mcpEngine.CreateToken(ctx, agent.ID, "default")
if err != nil {
    return err
}
fmt.Println(issued.Secret) // mcp_...
```

`CreateToken` returns an `IssuedToken`: the stored token row in `Token` and the raw secret in `Secret`.

A token looks like this:

```
mcp_Qf3x9...   (the prefix "mcp_" and 43 random characters)
```

The package stores only the SHA-256 hash of the token, never the token itself. **The raw secret is returned once.** After that the package cannot show it again, because it no longer has it. A lost token cannot be recovered, only replaced.

Each token has:

| Field | Meaning |
|---|---|
| `name` | A label you choose. Unique for the agent. At most 255 characters |
| `expires_at` | Now plus the `token_expiry_days` setting, fixed when the token is issued |
| `last_used_at` | Updated each time the token is used on `/mcp` |
| `revoked_at` | Set when the token is revoked |

An agent can have several tokens at once, such as one per environment. Issuing a second token with a name the agent already uses fails with `ErrTokenExists`.

With the admin handler, the same thing is a `POST /agents/{id}/tokens` with `{"name": "..."}`. The response is the token row plus the secret under the key `token`.

---

## How a token is checked

Every call to `/mcp` goes through the same check:

1. Read the `Authorization: Bearer ...` header. No token gives `ErrMissingToken`.
2. Hash the token and look the hash up. No match gives `ErrInvalidToken`.
3. Load the agent from your `AgentStore`. A token whose agent no longer exists also gives `ErrInvalidToken`.
4. If the token was revoked, the result is `ErrRevokedToken`.
5. If `expires_at` has passed, the result is `ErrExpiredToken`.

Any of those errors is a `401` on `/mcp`. When the check passes, the package notes `last_used_at` and the call continues.

---

## Managing tokens

| Engine method | What it does |
|---|---|
| `CurrentToken(ctx, agentID)` | The agent's newest token that is not revoked. `nil` when it has none |
| `RotateToken(ctx, agentID, name)` | Deletes **every** token of the agent, then issues one named `name` |
| `RevokeToken(ctx, agentID, tokenID)` | Marks one token revoked. It stops working at once, and the row stays |
| `DeleteToken(ctx, agentID, tokenID)` | Removes one token row |

`RevokeToken` and `DeleteToken` return `ErrTokenNotFound` for a token that does not belong to that agent.

The admin handler has `GET /agents/{id}/tokens` to list an agent's tokens, and `DELETE /agents/{id}/tokens/{tokenID}`, which **revokes** the token. The listing never contains a hash or a secret.

---

## Removing an agent

Your app owns the agents table, so your app deletes the row. Before that, tell the package:

```go
if err := mcpEngine.ForgetAgent(ctx, agentID); err != nil {
    return err
}
// then delete the agent from your own table
```

`ForgetAgent` deletes the agent's tokens and its failure streak. The log rows stay, so you can still see what the agent did.

---

## Letting your routes recognise an agent

A tool call arrives at your route as an ordinary HTTP request. The package copies the agent's token into it:

```
Authorization: Bearer mcp_...
```

So the route's authentication middleware sees a bearer token that is not a user session. Your app decides what to do with it. To accept agents, teach that middleware to recognise the token and resolve it with `engine.Authenticate`:

```go
func agentAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
        if !strings.HasPrefix(raw, "mcp_") {
            next.ServeHTTP(w, r) // not an agent token: your normal user check goes here
            return
        }

        principal, err := mcpEngine.Authenticate(r.Context(), raw)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }

        ctx := context.WithValue(r.Context(), agentKey{}, principal.AgentID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

`Authenticate` returns a `Principal`:

| Field | Meaning |
|---|---|
| `AgentID` | The agent's `ID` |
| `TokenID` | The token that was used |
| `AgentName` | The agent's name |
| `TokenName` | The token's name |

What happens after that is your app's design. A common one is to treat the `AgentID` as a subject in your access system, next to your users. The package exports the constant `mcp.SubjectTypeMachine`, with the value `"machine"`, as the name to use for that kind of subject.

The package does not look at your users and does not check access. A route that does not check who is calling accepts every valid agent token.

---

## Settings that affect agents

| Setting | Effect |
|---|---|
| `token_expiry_days` | Lifetime of tokens issued from now on |
| `max_consecutive_failures` and `failure_cooldown_seconds` | When an agent is blocked, and for how long |

See [Configuration](./config.md).

---

## What's next

| Page | What you'll find |
|---|---|
| [Tool calls](./calls.md) | What happens on a call, the errors an agent sees, and the call log |
| [Configuration](./config.md) | Token expiry, cooldown and the other limits |
| [Reference](./reference.md) | Every method, error and table |
