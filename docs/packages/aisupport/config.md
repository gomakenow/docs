---
title: Configuration
description: Tune behavior, defaults, and limits to fit your needs.
---

# Configuration

The aisupport package works with sensible defaults out of the box. `DB` and an LLM function are required. Start with the other defaults and tune later only if you have specific needs.

---

## How configuration works

The aisupport system has two separate engines: one for chat and one for documentation. You initialize both with a single `aisupport.Config`:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
    },
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{...},
    },
})
```

`DB` is the PostgreSQL connection both engines share. It is required. If it is nil, `Init` stops the process. `Init` passes that connection to the chat engine and the docs engine. Do not set a separate database on either config.

**Chat configuration** controls how conversations are stored and answered: which LLM to use, how much history to remember, how many docs to include, and what limits to enforce. See [Chat configuration](#chat-configuration) below.

**Docs configuration** controls how documentation is indexed and searched: which GitHub repositories to track, webhook verification, and whether to use semantic search. See [Docs configuration](#docs-configuration) below.

The two engines integrate automatically: when you ask a question, the chat engine retrieves relevant docs and includes them in the LLM prompt. But they can work independently too — use chat without docs, or build your own search UI for docs.

---

## Website identity

Set the website name and public address on the chat config. The package writes them into the built-in system prompt when the chat engine starts:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
    },
    // ...
})
```

The generated prompt:
- Names the assistant: "You are Acme's support assistant"
- Sets the scope: "Stay inside Acme: https://acme.example, its documentation, ..."
- Always includes the parsing rules: `[[CODE]]`, `[[USED:n,n]]`, and `[[NO_ANSWER]]`

Leave either field empty and that part of the prompt stays generic ("this product"). The package owns the system prompt. You cannot replace the marker rules.

::: info
The package generates the system prompt automatically to ensure it always includes the token parsing rules. Don't write the system prompt yourself. Pass `SystemPrompt` in `ChatConfig` only if you need to append optional extra instructions.
:::

---

## Chat configuration

The chat engine stores conversations and answers questions. Configuration controls which LLM provider to call, how much history to send, how many docs to include, and what limits to enforce. The database comes from `aisupport.Config.DB`.

### Required fields

**`LLM`** — Your LLM provider function. This bridges to OpenRouter, OpenAI, Claude, or any provider. See [LLM and retrieval](./llm.md) for implementation details.

```go
ChatConfig{
    LLM: callOpenRouter,  // func(ctx, req) -> (resp, err)
}
```

### Optional tuning fields

**`HistoryLimit`** (default: 10)

How many recent messages from the conversation to send to the LLM. Higher = better context for follow-ups, but higher token cost.

```go
ChatConfig{
    HistoryLimit: 5,   // Tight budget, cheaper LLM calls
    HistoryLimit: 20,  // Generous, better follow-up understanding
    HistoryLimit: -1,  // Include all history
}
```

Use higher when:
- Users ask complex follow-ups that need context
- You have a generous token budget
- Your LLM benefits from more conversational context

Use lower when:
- Tokens are expensive
- Users mostly ask independent questions
- You want faster LLM response times

**`RetrieveLimit`** (default: 5)

Max documentation chunks to fetch and include per question. Higher = more docs in the prompt, larger context window.

```go
ChatConfig{
    RetrieveLimit: 3,   // Few docs, smaller prompts, cheaper
    RetrieveLimit: 10,  // More docs, better answers when docs are large
}
```

Use higher when:
- Your documentation is comprehensive but each chunk is small
- You want to give the LLM more context to improve answers
- You have budget for larger prompts

Use lower when:
- You want smaller, faster prompts
- Token costs matter
- Your docs are already focused and one or two chunks usually suffice

**`MaxQuestionLen`** (default: 2000 runes)

Maximum question length. Prevents extremely long inputs.

```go
ChatConfig{
    MaxQuestionLen: 500,   // Short questions only, prevent abuse
    MaxQuestionLen: 5000,  // Allow longer detailed questions
    MaxQuestionLen: -1,    // No limit
}
```

Use lower to:
- Prevent spam or resource abuse
- Keep prompts small
- Force users to ask focused questions

Use higher to:
- Allow detailed problem descriptions
- Support copy-paste of error messages
- Let users provide full context

**`MaxContextChars`** (default: 12000 bytes)

Byte limit for documentation chunks in the prompt. Prevents huge context windows.

```go
ChatConfig{
    MaxContextChars: 5000,    // Tight budget
    MaxContextChars: 20000,   // Generous
    MaxContextChars: -1,      // No limit
}
```

Use lower to:
- Control token/cost strictly
- Keep LLM response time fast
- Force docs to be concise

Use higher to:
- Give the LLM more context
- Support larger documentation excerpts
- Improve answer quality

### `Retrieve` (optional, default: nil)

Function to fetch documentation chunks. Defaults to searching the docs engine. See [LLM and retrieval](./llm.md) for custom retrievers.

```go
ChatConfig{
    Retrieve: nil,           // Use docs engine search
    Retrieve: customSearch,  // Use your own search
}
```

Most users use the default (docs engine search). Only customize if you search documentation differently (e.g., a custom system, different database, special logic).

---

## Docs configuration

The docs engine indexes and searches documentation. Configuration controls which repositories to track, how to verify webhooks, whether to use semantic search, and how many results to return by default.

### Required or conditional fields

The database is `aisupport.Config.DB`. `Init` passes it to the docs engine. `DocsConfig.DB` and `DocsConfig.DSN` are for `NewDocs`, when you build the docs engine on its own. `DSN` is a connection string the package opens when `DB` is nil.

**`WebhookSecret`** — Required unless every repository sets its own `WebhookSecret`.

GitHub webhook verification secret. Must match what you configured in GitHub settings. Store in an environment variable, never in code.

```go
DocsConfig{
    WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
}
```

::: warning
GitHub verifies the webhook signature using this secret. Without it (or with the wrong value), webhook verification fails and the index won't update on pushes.
:::

### Optional configuration fields

**`Repos`** (default: empty list)

GitHub repositories to index. When empty, the engine reads from the database (dynamic configuration).

```go
DocsConfig{
    Repos: []aisupport.Repo{
        {
            Owner:    "mycompany",
            Name:     "docs",
            Ref:      "main",
            DocsRoot: "docs",
            BaseURL:  "https://docs.example.com",
        },
    },
}
```

Omit this and configure repos via API if you want dynamic control. Include it and repos are fixed at startup.

**`RawSources`** (default: empty list)

Custom chunk sets from your database (FAQ, KB, etc.). No auto-indexing; you index them manually. See [Documentation search](./docs.md).

```go
DocsConfig{
    RawSources: []aisupport.Source{
        {Owner: "myapp", Name: "faq"},
        {Owner: "myapp", Name: "kb"},
    },
}
```

**`GitHubToken`** (default: empty)

GitHub personal access token for private repositories. Required for private repos, optional for public ones.

```go
DocsConfig{
    GitHubToken: os.Getenv("GITHUB_TOKEN"),
}
```

Can be overridden per-repository if you have multiple tokens (e.g., one for each organization).

**`SearchLimit`** (default: 5)

Default result count when a search doesn't specify a limit. Higher = return more chunks by default.

```go
DocsConfig{
    SearchLimit: 3,   // Few results by default
    SearchLimit: 10,  // Many results by default
}
```

**`ContactLLM`** (default: nil, disabled)

Function to generate embeddings for semantic search. When nil, only word search runs.

```go
DocsConfig{
    ContactLLM: nil,              // Word search only
    ContactLLM: generateEmbedding, // Semantic + word search
}
```

Enable this when you want:
- Better search quality on vague or semantic queries
- Meaning-based matching ("authenticate" finds "sign in")
- More accurate documentation retrieval

Disable when:
- You want to save on embedding costs
- Word search is sufficient for your docs
- Your docs are small and focused

---

## Practical tuning scenarios

### Budget-conscious setup

Minimize token usage and LLM costs:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:             callOpenRouter,
        WebsiteName:     "Acme",
        WebsiteAddress:  "https://acme.example",
        HistoryLimit:    5,        // Less history
        RetrieveLimit:   3,        // Fewer docs
        MaxContextChars: 8000,     // Tight budget
        MaxQuestionLen:  1000,     // Shorter questions
    },
    Docs: aisupport.DocsConfig{
        ContactLLM: nil,  // No embeddings (no extra LLM calls)
    },
})
```

### Quality-focused setup

Prioritize answer quality over cost:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:             callOpenRouter,
        WebsiteName:     "Acme",
        WebsiteAddress:  "https://acme.example",
        HistoryLimit:    20,       // Full context
        RetrieveLimit:   8,        // Lots of docs
        MaxContextChars: 20000,    // Generous budget
        MaxQuestionLen:  5000,     // Allow detailed questions
    },
    Docs: aisupport.DocsConfig{
        ContactLLM: generateEmbedding,  // Semantic search
    },
})
```

### Balanced setup (recommended)

Good defaults for most apps:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
        // Use defaults for everything else
    },
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{
            {Owner: "mycompany", Name: "docs", Ref: "main", DocsRoot: "docs", BaseURL: "https://docs.example.com"},
        },
        // Use defaults for everything else
    },
})
```

Start here. Measure performance and costs. Adjust if needed.

---

## Negative values disable limits

Pass -1 to disable any integer limit:

```go
ChatConfig{
    HistoryLimit:    -1,  // Include all history
    MaxQuestionLen:  -1,  // No question length limit
    MaxContextChars: -1,  // No doc size limit
}
```

Useful for testing or special cases. In production, limits are usually good.

---

## When to tune

Start with defaults. Measure:
- LLM response time
- Token usage and cost
- Answer quality (satisfaction rate from analytics)
- Escalation rate (conversations needing human help)

Then adjust:
- **Slow responses** → Reduce `HistoryLimit`, `RetrieveLimit`, or `MaxContextChars`
- **High costs** → Reduce limits or disable `ContactLLM`
- **Poor answers** → Increase `HistoryLimit`, `RetrieveLimit`, or enable `ContactLLM`
- **High escalations** → Increase doc retrieval or improve documentation

Most apps never tune. Defaults are well-chosen for the common case.

---

## Config inheritance and defaults

When you initialize the engine, the package applies these rules:

1. **Database** — `DB` is required. `Init` passes it to both engines. A nil `DB` stops the process.
2. **Website identity** — `Chat.WebsiteName` and `Chat.WebsiteAddress` are written into the built-in system prompt. Leave either one empty and that part of the prompt stays generic.
3. **Retriever** — If `Chat.Retrieve` is nil, the package searches the docs engine.
4. **Zero-value limits** — Zero means use the built-in default (e.g., 10 for `HistoryLimit`, 5 for `RetrieveLimit`).
5. **Negative values** — Pass -1 to disable a limit entirely (e.g., `HistoryLimit: -1` includes all history).

This design lets you write minimal config and get sensible behavior out of the box.
