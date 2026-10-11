---
title: Documentation search
description: Keep your documentation indexed and searchable so the AI can cite it when answering questions.
---

# Documentation search

When a user asks a question, the AI needs documentation to cite. The documentation system keeps your docs indexed, up-to-date, and searchable. Every time you push changes to GitHub, the index updates automatically. When a user asks a question, the AI searches the index and returns the most relevant sections for the LLM to use.

This page shows how documentation indexing and searching works, then how to set it up and use it.

---

## How indexing works

Documentation starts on GitHub as markdown files. Here's what happens:

**1. You configure a repository:**
```
Owner: "mycompany"
Name: "docs"
Ref: "main"
DocsRoot: "docs"
BaseURL: "https://docs.example.com"
```

**2. The system fetches the repository:**
Downloads all markdown from the tracked branch. Only the `DocsRoot` directory is indexed (e.g., `/docs/*.md`).

**3. Markdown is chunked:**
Splits at heading boundaries. Each section becomes one searchable chunk:
```markdown
# Getting started        ← Chunk 1 title
Intro text...           ← Chunk 1 content

## Installation         ← Chunk 2 title
Run npm install...      ← Chunk 2 content

## Configuration        ← Chunk 3 title
Set API key...          ← Chunk 3 content
```

**4. Each chunk is stored:**
- Title: "Installation"
- URL: "https://docs.example.com/getting-started#installation" (with anchor)
- Content: "Run npm install..."
- Repo: "docs"

**5. Chunks are indexed:**
Stored in the database so they can be searched quickly.

**6. Optionally, embeddings are generated:**
If you provide an embedding function, each chunk is converted to a vector (a list of numbers representing its meaning). This enables semantic search later.

---

## How searching works

When a user asks "How do I install this?", here's what happens:

**1. The question is received:**
"How do I install this?"

**2. The system searches the index:**

Without embeddings (word search):
- Finds chunks containing words like "install", "setup", "npm", etc.
- Returns the best matches ranked by relevance

With embeddings (semantic search):
- Converts the question to a vector
- Finds chunks with similar vectors (meaning-based matching)
- Example: finds "How to get started" even though the words don't match
- Combines semantic results with word search results

**3. Top chunks are returned:**
```
Chunk 1: "Installation" → "Run npm install..." 
Chunk 2: "Setup" → "Configure your environment..."
Chunk 3: "Getting started" → "First time users should..."
```

**4. Chunks are passed to the LLM:**
The LLM reads the chunks and uses them to answer the question.

**5. User sees sourced answers:**
```
AI: "To install, run npm install. Then configure your environment...

📚 Installation (https://docs.example.com/getting-started#installation)
📚 Setup (https://docs.example.com/getting-started#setup)
```

The user can click the links to read the full documentation.

---

## Keeping the index up-to-date

The index updates automatically when you push to GitHub:

**1. You push changes to the tracked branch:**
```
git push origin main
```

**2. GitHub sends a webhook:**
A notification arrives at your server with:
- Which repository changed
- Which files were added, modified, or deleted

**3. The system fetches changed files:**
Downloads only the files that changed (not the whole repo).

**4. Changed files are re-chunked:**
- Removed files → chunks deleted
- Modified files → chunks updated
- New files → chunks created

**5. The index updates:**
Search now returns the latest content.

This all happens automatically. You don't need to do anything except push to GitHub.

---

## Setting up documentation

Now that you understand how it works, here's how to configure it.

### GitHub repositories

Point the system at your documentation repositories:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{
            {
                Owner:    "mycompany",
                Name:     "docs",
                Ref:      "main",
                DocsRoot: "docs",
                BaseURL:  "https://docs.example.com",
            },
        },
    },
    Chat: aisupport.ChatConfig{
        LLM: callOpenRouter,
    },
})
```

Each repository specifies:
- **Owner** and **Name** — GitHub repository identifier
- **Ref** — Branch to track ("main", "master", etc.)
- **DocsRoot** — Directory containing markdown. Empty means repository root.
- **BaseURL** — Public URL of your published docs. Used to generate links in answers.

You can point to multiple repositories. The system searches across all of them.

### Webhook setup

GitHub needs to notify your server when changes are pushed:

1. Go to your repository's **Settings** → **Webhooks**
2. Click **Add webhook**
3. **Payload URL** — Your server, e.g., `https://example.com/webhooks/docs`
4. **Content type** — `application/json`
5. **Secret** — Your `WebhookSecret` value
6. **Events** — **Just the push event**
7. Click **Add webhook**

Now every push to the tracked branch updates the index automatically.

::: warning
The webhook secret verifies that notifications really came from GitHub. Use a strong random value (32+ characters). Store it in an environment variable, never in code.
:::

### Mounting the webhook handler

The aisupport engine comes with a pre-built, ready-to-use webhook handler. Just mount it on your router:

```go
router.HandleFunc("POST /webhooks/docs", engine.Docs.Handler())
```

That's it. The handler:
- Verifies the webhook signature (ensures the request really came from GitHub)
- Identifies which repository changed
- Fetches the changed files from GitHub
- Chunks the markdown
- Updates the index

If the signature is invalid, it returns 401 Unauthorized. If the repository isn't in your config, it returns 404 Not Found. Otherwise, it updates the index and returns 200 OK.

You don't need to write any webhook logic yourself — it's all built in.

---

## Initial indexing

After deploying, the index is empty. Run an initial index to populate it:

```go
err := engine.Docs.ReindexAll(ctx)
if err != nil {
    return err
}
```

This downloads each repository as a tarball, chunks the markdown, and stores it. It's slow the first time (could take a minute) but ensures everything is indexed before webhooks start arriving.

After initial indexing, webhooks handle incremental updates. New pushes only update changed files.

::: warning
Run `ReindexAll` once at startup as a background job or separate command. Don't call it in a request handler — it blocks.
:::

---

## Using documentation in your chat

Documentation is automatically integrated into the chat. When a user asks a question:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: 0,
    Owner: owner,
    Question: "How do I integrate webhooks?",
})

// resp.Answer.Sources contains chunks from your GitHub repos
for _, source := range resp.Answer.Sources {
    fmt.Printf("📚 %s: %s\n", source.Title, source.URL)
}
```

The AI automatically searches your documentation, finds relevant chunks, and includes them in the LLM prompt. The LLM cites those chunks in its answer. You display the sources below the answer so users can click through to your docs.

This happens automatically. You don't call search directly — just use `Ask` and the documentation is integrated.

---

## Improving search quality

By default, search uses word matching. For better results on vague or semantic queries, enable semantic search by providing an embedding function:

```go
func generateEmbedding(model, text string, provider *string) (string, error) {
    // Call an embedding model (e.g., OpenRouter, OpenAI)
    // Return a JSON array of numbers: [0.123, -0.456, ...]
    // This converts text to a vector that captures its meaning
}

engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Docs: aisupport.DocsConfig{
        ContactLLM: generateEmbedding,  // Enable semantic search
        // ... rest of config
    },
    Chat: aisupport.ChatConfig{...},
})
```

With semantic search:
- "How do I authenticate?" finds chunks about "login", "sign in", "credentials"
- Meaning is matched, not just exact words
- Works well for natural language questions

::: info
Semantic search costs more (you're generating embeddings) but improves answer quality, especially for vague questions. Start with word search, then add embeddings if quality is poor.
:::

---

## Adding custom documentation

Not all documentation comes from GitHub. FAQ articles, KB entries, or product documentation might live in your database. Add them as raw sources:

```go
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{  // GitHub docs
            {Owner: "mycompany", Name: "docs", Ref: "main", DocsRoot: "docs", BaseURL: "https://docs.example.com"},
        },
        RawSources: []aisupport.Source{  // Custom docs from your database
            {Owner: "myapp", Name: "faq"},
            {Owner: "myapp", Name: "kb"},
        },
    },
    Chat: aisupport.ChatConfig{...},
})
```

Raw sources are just identifiers. You manually index their chunks:

```go
chunks := []aisupport.Chunk{
    {
        Title:   "How do I reset my password?",
        URL:     "https://example.com/faq#password",
        Content: "Click 'Forgot password' on the login page...",
    },
}

result, err := engine.Docs.IndexRawChunks(ctx, aisupport.Source{Owner: "myapp", Name: "faq"}, chunks)
```

When FAQ articles change, update them:

```go
chunks := []aisupport.Chunk{
    {
        Title:   "How do I reset my password?",
        URL:     "https://example.com/faq#password",
        Content: "Updated instructions: Click 'Forgot password' and check your email...",
    },
}

result, err := engine.Docs.UpsertRawPath(ctx, aisupport.Source{Owner: "myapp", Name: "faq"}, chunks)
```

To remove a chunk:

```go
result, err := engine.Docs.DeleteRawPath(ctx, aisupport.Source{Owner: "myapp", Name: "faq"}, "faq/old-article.md")
```

This pattern lets you keep FAQ or KB entries in sync by indexing directly from your database.

---

## Monitoring the index

Check if indexing is complete:

```go
readiness, err := engine.Docs.Readiness(ctx)
if !readiness.Ready {
    fmt.Printf("Still indexing: %d sources, %d chunks\n", 
        readiness.SourceCount, readiness.ChunkCount)
}
```

Check the status of each repository:

```go
statuses, err := engine.Docs.Indexes(ctx)
for _, status := range statuses {
    fmt.Printf("%s/%s: %s\n", status.Owner, status.Name, status.Status)
    if status.Error != "" {
        fmt.Printf("  Error: %s\n", status.Error)
    }
}
```

Status values:
- `"pending"` — Not yet indexed
- `"indexed"` — Successfully indexed
- `"failed"` — Last index attempt failed

Use `Readiness` to implement a health check before searches. Use `Indexes` to display status to admins.

---

## Reindexing

To rebuild the index for one repository (if you change `DocsRoot` or `BaseURL`):

```go
err := engine.Docs.ReindexRepo(ctx, "mycompany", "docs")
```

To rebuild all repositories:

```go
err := engine.Docs.ReindexAll(ctx)
```

---

## Complete example

A typical setup:

```go
// Initialize with documentation
engine, err := aisupport.Init(aisupport.Config{
    DB: db,
    Docs: aisupport.DocsConfig{
        WebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
        Repos: []aisupport.Repo{
            {
                Owner:    "mycompany",
                Name:     "docs",
                Ref:      "main",
                DocsRoot: "docs",
                BaseURL:  "https://docs.example.com",
            },
        },
        ContactLLM: generateEmbedding,  // Semantic search
    },
    Chat: aisupport.ChatConfig{
        LLM: callOpenRouter,
    },
})

// Mount the webhook
router.HandleFunc("POST /webhooks/docs", engine.Docs.Handler())

// Initial index
engine.Docs.ReindexAll(ctx)

// Now when users ask questions, answers are sourced from your docs
resp, _ := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: 0,
    Owner: owner,
    Question: "How do I get started?",
})

fmt.Printf("AI: %s\n", resp.Answer.Content)
for _, source := range resp.Answer.Sources {
    fmt.Printf("📚 [%s](%s)\n", source.Title, source.URL)
}
```

This is the full flow: docs on GitHub → webhook syncs → chat searches → LLM cites → users see sourced answers.

---

## Direct search (advanced)

Most users integrate documentation through the chat system. If you need to search documentation directly (not through the LLM), you can call search:

```go
chunks, err := engine.Docs.Search(ctx, aisupport.SearchRequest{
    Query: "How do I authenticate?",
    Limit: 5,
})

for _, chunk := range chunks {
    fmt.Printf("Title: %s\n", chunk.Title)
    fmt.Printf("URL: %s\n", chunk.URL)
}
```

Search returns up to `Limit` chunks sorted by relevance. Use this if you're building a documentation search UI separate from the chat, or if you want to debug search results.
