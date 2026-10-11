---
title: LLM and retrieval
description: Implement your LLM provider and customize how questions are answered.
---

# LLM and retrieval

The aisupport engine doesn't call an LLM provider directly. You provide a function that bridges to your provider. This gives you complete control: choose any provider, implement custom logic, handle cost controls, enable fallbacks, or even use local models.

This page shows how the LLM integration works, then how to implement it for your provider.

---

## How the LLM is called

When a user asks a question, here's what happens:

**1. The question is received and validated**

**2. Documentation is retrieved** (if configured)

**3. The system assembles a prompt:**
- Your system prompt
- Conversation history (last 10 messages by default)
- Documentation chunks (up to 12000 bytes by default)
- The current question

The prompt is assembled into a standard format:
```
[System prompt about who you are and how to behave]

[Previous Q&A from the conversation]

Here are some relevant docs:
[Documentation chunk 1]
[Documentation chunk 2]
...

User's current question: How do I set up webhooks?
```

**4. Your LLM function is called** with the assembled prompt

**5. Your function transforms the prompt** to your provider's API format

**6. Your function calls the provider** (OpenRouter, OpenAI, Claude, etc.)

**7. Your function parses the response** and returns the assistant's reply

**8. The response is stored** and returned to the user

---

## The LLM function signature

You provide a function with this signature:

```go
func callMyProvider(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error)

type LLMRequest struct {
    Messages       []LLMMessage  // Already assembled, ready to send
    ConversationID uint          // Current conversation ID
    Owner          Owner         // Who is asking (for tracking/logging)
}

type LLMMessage struct {
    Role    string  // "user" or "assistant"
    Content string  // The text
}

type LLMResponse struct {
    Content string  // The assistant's reply
}
```

The `Messages` field is already assembled and ready to send to your provider. You don't need to build the prompt yourself — the aisupport system does that. You just transform it to your provider's format, call the API, and return the response.

---

## The built-in system prompt

The package owns the system prompt. It tells the model how to answer, when to stay on topic, how to wrap copyable code in `[[CODE]]`, how to end with `[[USED:n,n]]` citations, and when to emit `[[NO_ANSWER]]` for escalation. Those markers are what the package parses to extract answers and citations.

The package generates the prompt automatically using your website identity:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
    },
    Docs: aisupport.DocsConfig{},
})
```

The generated prompt names the assistant ("You are Acme's support assistant") and sets the scope ("Stay inside Acme: https://acme.example..."). When you don't provide a name or address, the prompt stays generic.

The package always includes the `[[CODE]]`, `[[USED]]`, and `[[NO_ANSWER]]` rules. These are essential — the package cannot work without them.

**`Chat.SystemPrompt`** — When set, optional text is appended after the built-in prompt. Use this for extra instructions, but know that you cannot replace or remove the marker rules.

```go
ChatConfig{
    SystemPrompt: "For security questions, always recommend contacting our security team.",
}
```

::: warning
Never write your own system prompt to replace the built-in one. The package generates it to ensure the parsing rules are always present. If a host-written prompt omitted `[[CODE]]` or `[[USED:n,n]]`, the package couldn't parse answers correctly and would break.
:::

---

## Implementing your LLM function

Here's a complete example using OpenRouter:

```go
func callOpenRouter(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    // req.Messages is already assembled with system prompt, history, docs, and question
    // Transform to OpenRouter's format
    
    openRouterReq := map[string]interface{}{
        "model": "openai/gpt-4",
        "messages": req.Messages,  // Already formatted as []{"role": "...", "content": "..."}
    }
    
    // Call OpenRouter API
    body, _ := json.Marshal(openRouterReq)
    httpReq, _ := http.NewRequestWithContext(ctx, "POST", 
        "https://openrouter.io/api/v1/chat/completions",
        bytes.NewReader(body))
    httpReq.Header.Set("Authorization", "Bearer "+os.Getenv("OPENROUTER_KEY"))
    httpReq.Header.Set("Content-Type", "application/json")
    
    resp, err := http.DefaultClient.Do(httpReq)
    if err != nil {
        return aisupport.LLMResponse{}, err
    }
    defer resp.Body.Close()
    
    // Parse response
    var result map[string]interface{}
    json.NewDecoder(resp.Body).Decode(&result)
    
    choices := result["choices"].([]interface{})
    choice := choices[0].(map[string]interface{})
    message := choice["message"].(map[string]interface{})
    content := message["content"].(string)
    
    return aisupport.LLMResponse{Content: content}, nil
}
```

Pass it to aisupport:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
    },
    Docs: aisupport.DocsConfig{...},
})
```

---

## Understanding retrieval

Retrieval is how documentation gets included in the prompt. By default, when a user asks a question, the system searches your documentation and includes the best matching chunks in the LLM prompt.

You don't implement retrieval yourself — it's built in. The system:
1. Searches your documentation index
2. Returns the top chunks (default 5)
3. Includes them in the prompt

The LLM then sees the documentation and can cite it in its answer.

If you don't configure documentation (no GitHub repos or raw sources), the system still works — it just calls the LLM with no documentation. The LLM answers based on its training and conversation history.

---

## Advanced customization: Retrieval and LLM

Most users use the default behavior: standard documentation search and a single LLM provider. But the package is flexible — you can customize how documentation is retrieved and how the LLM is called.

### Custom retrieval

In rare cases, search your own system instead of the aisupport docs:

```go
func customRetriever(ctx context.Context, req aisupport.RetrieveRequest) ([]aisupport.DocChunk, error) {
    // req.Query is the user's question
    // req.Limit is how many chunks to return (default 5)
    // req.History is the conversation history
    
    // Search your own system
    chunks, err := mySearchEngine.Search(ctx, req.Query, req.Limit)
    if err != nil {
        return nil, err
    }
    
    // Map to aisupport format
    out := make([]aisupport.DocChunk, len(chunks))
    for i, chunk := range chunks {
        out[i] = aisupport.DocChunk{
            Title:   chunk.Title,
            URL:     chunk.URL,
            Content: chunk.Content,
            Name:    chunk.Source,
        }
    }
    return out, nil
}

engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        Retrieve: customRetriever,  // Use custom retriever instead of docs search
        // ...
    },
    Docs: aisupport.DocsConfig{...},
})
```

### Custom LLM provider patterns

Wrap your LLM function to add features like fallback models, cost control, or logging:

#### Fallback models

Try a cheaper or different model if your primary one fails:

```go
func callWithFallback(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    models := []string{"openai/gpt-4", "anthropic/claude-3-sonnet", "openai/gpt-3.5-turbo"}
    
    var lastErr error
    for _, model := range models {
        resp, err := callOpenRouter(ctx, req, model)
        if err == nil {
            return resp, nil
        }
        lastErr = err
    }
    return aisupport.LLMResponse{}, lastErr
}
```

#### Cost control

Use cheaper models for simple questions:

```go
func callSmartModel(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    model := "openai/gpt-3.5-turbo"  // Default: cheap
    
    // Use expensive model if conversation is long
    if len(req.Messages) > 20 {
        model = "openai/gpt-4"
    }
    
    return callOpenRouter(ctx, req, model)
}
```

#### Logging and metrics

Track usage for monitoring:

```go
func callTrackedOpenRouter(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    start := time.Now()
    resp, err := callOpenRouter(ctx, req)
    
    duration := time.Since(start)
    logMetric("aisupport.llm_latency_ms", duration.Milliseconds())
    logMetric("aisupport.llm_owner", req.Owner.ID)
    
    if err != nil {
        logMetric("aisupport.llm_errors", 1)
    }
    
    return resp, err
}

engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM: callTrackedOpenRouter,
        // ...
    },
    // ...
})
```

---

## Handling "needs human" escalation

Sometimes the AI can't help and should route to a human. Check the `NeedsHuman` flag:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{...})

if resp.NeedsHuman {
    // Route to human support queue
    // The answer is still stored and shown to the user
}
```

When the LLM determines it can't help with a request, `NeedsHuman` is set to true. Use this to route the conversation to your support team. The answer is still stored and shown to the user — they just know a human will follow up.

---

## Configuration: Limits and history

Control how much context the LLM receives:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        HistoryLimit:    10,      // How many previous messages to include (default 10)
        RetrieveLimit:   5,       // How many doc chunks to include (default 5)
        MaxContextChars: 12000,   // Max bytes of doc content (default 12000)
        MaxQuestionLen:  2000,    // Max question length in runes (default 2000)
        // ...
    },
    // ...
})
```

More history = better context but higher token cost. Less history = cheaper but the LLM might miss context.

More doc chunks = better citations but larger prompts. Fewer chunks = faster, smaller prompts.

---

## Complete example

A full integration:

```go
// 1. Implement your LLM function
func callOpenRouter(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    // Transform req.Messages to OpenRouter format
    // Call OpenRouter API
    // Parse and return response
}

// 2. Initialize aisupport. The built-in prompt names the website.
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Chat: aisupport.ChatConfig{
        LLM:            callOpenRouter,
        WebsiteName:    "Acme",
        WebsiteAddress: "https://acme.example",
        HistoryLimit:   10,
        RetrieveLimit:  5,
    },
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{
            {Owner: "mycompany", Name: "docs", Ref: "main", DocsRoot: "docs", BaseURL: "https://docs.example.com"},
        },
    },
})

// 3. Use it
resp, _ := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: 0,
    Owner: owner,
    Question: "How do I get started?",
})

// resp.Answer.Content is the LLM's response
// resp.Answer.Sources are the cited documentation chunks
// resp.NeedsHuman tells you if escalation is needed
```

This is the complete flow: website identity, LLM function, and documentation. The package supplies the system prompt.
