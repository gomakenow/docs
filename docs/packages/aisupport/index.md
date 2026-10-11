---
title: Getting started
description: Three steps to add AI-powered support chat to your application.
---

# Getting started

<Badge type="tip" text="Requires migration" />

Most apps rely on a help email or support tickets: users ask, humans respond. This works at first, but it doesn't scale. Your support team gets overwhelmed. Users wait for answers.

The `aisupport` package answers common questions instantly using your own documentation. When a user asks "How do I set up webhooks?", the system searches your docs, feeds the relevant sections to an LLM, and delivers a sourced answer in seconds. Users get help immediately. Your team handles only the hard cases.

In three steps, you will have a working support chat.

---

## Step 1 — Publish the migrations

The package ships with SQL that creates database tables. Apply it:

```bash
make -C backend/aisupport migrate-publish
make migrate-up
```

This creates tables for conversations, messages, and documentation chunks.

---

## Step 2 — Initialize the engine

Call `aisupport.Init` once at startup:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{
            {
                Owner: "mycompany", Name: "docs", Ref: "main",
                DocsRoot: "docs", BaseURL: "https://docs.example.com",
            },
        },
    },
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter, // Your LLM provider call
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
        // Retrieve defaults to searching the docs engine
        // HistoryLimit defaults to 10
        // RetrieveLimit defaults to 5
        // MaxQuestionLen defaults to 2000
        // MaxContextChars defaults to 12000
    },
})
if err != nil {
    log.Fatal(err)
}
```

The engine uses sensible defaults. You only need to provide:
- `DB` — The PostgreSQL connection both engines share. A nil value stops the process.
- `LLM` — Your LLM provider function
- `WebsiteName` and `WebsiteAddress` on the chat config — Written into the built-in system prompt

Everything else uses defaults. The package generates the system prompt automatically with parsing rules built-in. For customization, see the [Configuration](./config.md) page.

::: info
`WebsiteName` and `WebsiteAddress` are written into the built-in system prompt. Leave either one empty and that part stays generic. The package already includes the copy-block, citation, and handoff markers, so you do not write those rules yourself.
:::

---

## Step 3 — Add a route and ask a question

Create an HTTP endpoint. Inject the engine as a dependency:

```go
func newAskHandler(engine *aisupport.Engine) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        user, _ := auth.UserFromContext(r.Context())
        
        var req struct {
            ConversationID uint   `json:"conversation_id"`
            Question       string `json:"question"`
        }
        json.NewDecoder(r.Body).Decode(&req)
        
        resp, err := engine.Chat.Ask(r.Context(), aisupport.AskRequest{
            ConversationID: req.ConversationID,
            Owner: aisupport.Owner{
                Kind: aisupport.OwnerUser,
                ID:   fmt.Sprintf("%d", user.ID),
            },
            Question: req.Question,
            Client:   aisupport.ClientWebsite,
        })
        if err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
        
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(resp)
    }
}

router.HandleFunc("POST /support/ask", newAskHandler(engine))
```

The response includes:
- `Answer.Content` — The assistant's reply
- `Answer.Sources` — Documentation chunks cited (with clickable URLs)
- `NeedsHuman` — True if the LLM marked it for escalation
- `ConversationID` — The conversation ID (save this for follow-ups)

---

## The LLM function

You must provide a function that calls your LLM provider. Here's the signature:

```go
func callOpenRouter(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    // req.Messages is already assembled with:
    // - System prompt
    // - Conversation history (last 10 messages by default)
    // - Documentation chunks (formatted for the LLM)
    // - Current question
    
    // Transform req.Messages to your provider's format and call it
    // Return the response
    
    return aisupport.LLMResponse{Content: assistantReply}, nil
}
```

For a complete example and how to integrate OpenRouter, OpenAI, or Claude, see the [LLM and retrieval](./llm.md) page.

---

## That's it

You now have:
- ✅ Conversations stored in the database
- ✅ Questions answered by your LLM using your documentation
- ✅ Sources cited in every answer
- ✅ History remembered across follow-ups
- ✅ Easy escalation to humans when needed

The package uses defaults for everything else. As you grow, customize:
- **Documentation search** — See [Documentation search](./docs.md) for GitHub webhooks, raw sources, embeddings
- **Chat behavior** — See [Chat and conversations](./chat.md) for conversation management, reactions, archiving
- **LLM integration** — See [LLM and retrieval](./llm.md) for custom retrievers, provider-specific features
- **Configuration** — See [Configuration](./config.md) for tuning limits and defaults
- **Monitoring** — See [Analytics](./analytics.md) for tracking usage and escalations
- **Debugging** — See [Error handling](./errors.md) for debugging and recovery
- **API reference** — See [Reference](./reference.md) for all types and methods

---

## Next steps

| Page | For |
|---|---|
| [Chat and conversations](./chat.md) | Storing conversations, listing, archiving, reactions |
| [Documentation search](./docs.md) | GitHub webhooks, indexing, searching, raw sources |
| [LLM and retrieval](./llm.md) | Implementing your LLM function, the built-in prompt, custom retrievers |
| [Analytics](./analytics.md) | Tracking usage, monitoring, understanding your data |
| [Configuration](./config.md) | Tuning limits, defaults, and behavior |
| [Error handling](./errors.md) | Debugging, recovery strategies, sentinel errors |
| [Reference](./reference.md) | Complete API reference and database schema |
