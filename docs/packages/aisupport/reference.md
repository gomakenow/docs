---
title: Reference
description: Complete API reference for the aisupport package.
---

# Reference

This page contains the complete API reference: every type, method, and function signature. For explanations and usage patterns, see the other pages in this documentation.

---

## Initialization

```go
engine, err := aisupport.Init(cfg aisupport.Config) (*aisupport.Engine, error)
```

Builds both the docs and chat engines. `DB` is required and is passed to both engines. A nil `DB` stops the process. `cfg.Chat.Retrieve` defaults to searching the docs engine if unset.

```go
chat, err := aisupport.NewChat(cfg aisupport.ChatConfig) (*aisupport.ChatEngine, error)
```

Builds only the chat engine. Call this if you do not need documentation search.

```go
docs, err := aisupport.NewDocs(cfg aisupport.DocsConfig) (*aisupport.DocsEngine, error)
```

Builds only the docs engine. Call this if you only want search without chat.

---

## Chat methods

### Ask

```go
resp, err := engine.Chat.Ask(ctx context.Context, req AskRequest) (*AskResponse, error)
```

Stores the question, retrieves docs, calls the LLM, stores the answer, and returns it.

**Errors:** `ErrEmptyQuestion`, `ErrQuestionTooLong`, `ErrInvalidOwner`, `ErrInvalidClient`, `ErrConversationNotFound`, `ErrRetrieveFailed`, `ErrLLMFailed`.

### Messages

```go
messages, err := engine.Chat.Messages(ctx context.Context, owner Owner, conversationID uint, limit int) ([]Message, error)
```

Returns messages in a conversation, oldest first. `limit <= 0` uses default (20).

**Errors:** `ErrInvalidOwner`, `ErrConversationNotFound`.

### Conversations

```go
conversations, err := engine.Chat.Conversations(ctx context.Context, owner Owner, limit int) ([]Conversation, error)
```

Returns non-archived conversations for the owner, most recently updated first. `limit <= 0` uses default (20).

**Errors:** `ErrInvalidOwner`.

### ArchiveConversation

```go
err := engine.Chat.ArchiveConversation(ctx context.Context, owner Owner, conversationID uint) error
```

Hides a conversation from the owner's list without deleting messages.

**Errors:** `ErrInvalidOwner`, `ErrConversationNotFound`.

### React

```go
msg, err := engine.Chat.React(ctx context.Context, owner Owner, messageID uint, reaction string) (*Message, error)
```

Records a reaction ("like", "dislike", or "clear") on an assistant message.

**Errors:** `ErrInvalidOwner`, `ErrMessageNotFound`.

### ClaimGuestConversations

```go
count, err := engine.Chat.ClaimGuestConversations(ctx context.Context, guestID, userID string) (int64, error)
```

Moves all conversations from a guest to a user.

---

## Docs methods

### Search

```go
chunks, err := engine.Docs.Search(ctx context.Context, req SearchRequest) ([]Chunk, error)
```

Returns up to `Limit` chunks for the query, sorted by relevance. Empty query or zero hits returns empty slice.

**Errors:** `ErrNilEngine`, database errors.

### Handler

```go
handler := engine.Docs.Handler() http.HandlerFunc
```

Returns the GitHub webhook handler. Mount once on your router:

```go
router.HandleFunc("POST /webhooks/docs", engine.Docs.Handler())
```

### Readiness

```go
readiness, err := engine.Docs.Readiness(ctx context.Context) (Readiness, error)
```

Reports whether the index is ready to serve searches.

### Indexes

```go
statuses, err := engine.Docs.Indexes(ctx context.Context) ([]IndexStatus, error)
```

Returns the status of each repository's index.

### Repos

```go
repos := engine.Docs.Repos() []Repo
```

Returns the configured repositories (fixed or from database).

### RawSources

```go
sources := engine.Docs.RawSources() []Source
```

Returns the configured raw chunk sources.

### Resources

```go
resources, err := engine.Docs.Resources(ctx context.Context) ([]Resource, error)
```

Returns fixed repos/sources, or all rows from docsync_sources if dynamic.

### Resource

```go
resource, err := engine.Docs.Resource(ctx context.Context, owner, name string) (Resource, error)
```

Returns one source by owner and name.

### CreateResource

```go
resource, err := engine.Docs.CreateResource(ctx context.Context, in Resource) (Resource, error)
```

Stores a new source and inserts a pending index row.

### UpdateResource

```go
resource, err := engine.Docs.UpdateResource(ctx context.Context, in Resource) (Resource, error)
```

Changes the branch, docs root, and base URL of a stored source.

### DeleteResource

```go
err := engine.Docs.DeleteResource(ctx context.Context, owner, name string) error
```

Removes a source, its index row, and its chunks.

### ReindexAll

```go
err := engine.Docs.ReindexAll(ctx context.Context) error
```

Downloads and re-indexes every configured repository.

### ReindexRepo

```go
err := engine.Docs.ReindexRepo(ctx context.Context, owner, name string) error
```

Re-indexes one repository.

### IndexRawChunks

```go
result, err := engine.Docs.IndexRawChunks(ctx context.Context, source Source, chunks []Chunk) (IndexResult, error)
```

Stores chunks for a raw source. Paths not in chunks are deleted.

### UpsertRawPath

```go
result, err := engine.Docs.UpsertRawPath(ctx context.Context, source Source, chunks []Chunk) (IndexResult, error)
```

Stores one path in a raw source. Other paths are left alone.

### DeleteRawPath

```go
result, err := engine.Docs.DeleteRawPath(ctx context.Context, source Source, path string) (IndexResult, error)
```

Removes one path from a raw source.

---

## Analytics methods

### Analytics

```go
snapshot, err := aisupport.Analytics(ctx context.Context, db *gorm.DB, window analytics.Window) (analytics.Snapshot, error)
```

Loads aggregated chat statistics for a time window.

### ParseAnalyticsWindow

```go
window, err := aisupport.ParseAnalyticsWindow(preset string, now time.Time) (analytics.Window, error)
```

Parses a preset ("7", "30", "60", "90", "365", "730", "all") into a time window.

### GenerateAnalyticsReport

```go
report, err := aisupport.GenerateAnalyticsReport(ctx context.Context, db *gorm.DB, window analytics.Window, llm LLMFunc) (string, error)
```

Generates a human-readable summary of analytics for the window.

---

## Type definitions

### AskRequest

```go
type AskRequest struct {
    ConversationID uint
    Owner          Owner
    Question       string
    Client         Client // empty is website
}
```

### AskResponse

```go
type AskResponse struct {
    ConversationID uint
    Answer         Message  // Content and Sources
    NeedsHuman     bool
}
```

### Owner

```go
type Owner struct {
    Kind string  // OwnerUser or OwnerGuest
    ID   string  // User ID or guest session ID
}

const OwnerUser = "user"
const OwnerGuest = "guest"
```

### Message

```go
type Message struct {
    ID             uint
    ConversationID uint
    Role           string      // RoleUser or RoleAssistant
    Client         Client      // Column and JSON name: source
    Content        string
    Sources        Sources     // For assistant messages
    Reaction       string      // "like", "dislike", or empty
    CreatedAt      time.Time
}

type Client string

const (
    ClientWebsite Client = "website"
    ClientDocSite Client = "doc-site"
    ClientMobile  Client = "mobile"
)

func ParseClient(value string) (Client, error)

const RoleUser = "user"
const RoleAssistant = "assistant"
```

`ParseClient` accepts `website`, `doc-site`, and `mobile`. A blank value is `website`. Anything else is `ErrInvalidClient`.

### Sources

```go
type Sources []Source

type Source struct {
    Title   string  // Heading or page title
    URL     string  // Clickable link
    Content string  // Excerpt
    Name    string  // Repository or source name
}
```

### Conversation

```go
type Conversation struct {
    ID        uint
    OwnerKind string    // OwnerUser or OwnerGuest
    OwnerID   string
    Archived  bool
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

### Chunk (docsync)

```go
type Chunk struct {
    Title   string
    URL     string
    Content string
    Repo    string
}
```

### SearchRequest

```go
type SearchRequest struct {
    Query string
    Limit int  // Max results; <= 0 uses SearchLimit
}
```

### Readiness

```go
type Readiness struct {
    Ready       bool
    SourceCount int
    ChunkCount  int64
}
```

### IndexStatus

```go
type IndexStatus struct {
    Owner      string
    Name       string
    Kind       string  // "repo" or "raw"
    Status     string  // "pending", "indexed", "failed"
    Error      string  // Empty if status != "failed"
    IndexedAt  time.Time
}
```

### IndexResult

```go
type IndexResult struct {
    ChunksCreated int64
    ChunksUpdated int64
    ChunksDeleted int64
}
```

### Resource

```go
type Resource struct {
    Owner    string  // Required
    Name     string  // Required
    Kind     string  // "repo" or "raw"
    Ref      string  // Branch (repo only)
    DocsRoot string  // Directory (repo only)
    BaseURL  string  // Published docs URL
}
```

### Repo

```go
type Repo struct {
    Owner         string
    Name          string
    Ref           string
    DocsRoot      string
    BaseURL       string
    GitHubToken   string  // Override shared token
    WebhookSecret string  // Override shared secret
}
```

### Source

```go
type Source struct {
    Owner string
    Name  string
}
```

### Config

```go
type Config struct {
    DB   *gorm.DB    // Required. Passed to both engines. Nil stops the process.
    Docs DocsConfig  // Documentation engine configuration
    Chat ChatConfig  // Chat engine configuration
}
```

### ChatConfig

```go
type ChatConfig struct {
    DB              *gorm.DB         // Set by Init. Required when calling NewChat directly.
    LLM             LLMFunc          // LLM provider function (required)
    Retrieve        RetrieveFunc     // Documentation retriever (default: docs engine)
    WebsiteName     string           // Written into the built-in system prompt
    WebsiteAddress  string           // Written into the built-in system prompt
    SystemPrompt    string           // Optional text appended after built-in prompt
    HistoryLimit    int              // Max messages sent to LLM (0 = 10, -1 = all)
    RetrieveLimit   int              // Max doc chunks to include (0 = 5)
    MaxQuestionLen  int              // Max question runes (0 = 2000, -1 = no limit)
    MaxContextChars int              // Max doc bytes in prompt (0 = 12000, -1 = no limit)
}
```

### DocsConfig

```go
type DocsConfig struct {
    DB            *gorm.DB      // Set by Init. For NewDocs, set this or DSN.
    DSN           string        // Connection string (alternative to DB)
    Repos         []Repo        // Fixed repositories to index
    RawSources    []Source      // Custom chunk sources to index
    GitHubToken   string        // Personal access token for private repos
    WebhookSecret string        // Webhook signature verification secret
    SearchLimit   int           // Default results per search (0 = 5)
    ContactLLM    ContactFunc   // Embeddings function for semantic search (nil = word search only)
}
```

---

## Function types

### LLMFunc

```go
type LLMFunc func(ctx context.Context, req LLMRequest) (LLMResponse, error)

type LLMRequest struct {
    Messages       []LLMMessage
    ConversationID uint
    Owner          Owner
}

type LLMResponse struct {
    Content string
}

type LLMMessage struct {
    Role    string  // "user" or "assistant"
    Content string
}
```

### RetrieveFunc

```go
type RetrieveFunc func(ctx context.Context, req RetrieveRequest) ([]DocChunk, error)

type RetrieveRequest struct {
    Query   string
    History []Message
    Limit   int
}

type DocChunk struct {
    Title   string
    URL     string
    Content string
    Name    string
}
```

### ContactFunc

```go
type ContactFunc func(model, prompt string, provider *string) (string, error)
```

For embeddings, returns a JSON array of numbers as a string.

---

## Sentinel errors

### Chat errors

```go
var (
    ErrEmptyQuestion       error
    ErrQuestionTooLong     error
    ErrInvalidOwner        error
    ErrInvalidClient       error
    ErrConversationNotFound error
    ErrRetrieveFailed      error
    ErrLLMFailed           error
    ErrNilEngine           error
)
```

### Docs errors

```go
package docsyncerrors

var (
    ErrNilEngine              error
    ErrInvalidConfig          error
    ErrWebhookSignatureInvalid error
    ErrRepositoryNotFound     error
    ErrSourceNotFound         error
)
```

---

## Database tables

### aichat tables

**aisupport_conversations** — Stores conversation metadata
- `id` (uuid, primary key)
- `owner_kind` (varchar, required)
- `owner_id` (varchar, required)
- `archived` (bool, default false)
- `created_at` (timestamp)
- `updated_at` (timestamp)

**aisupport_messages** — Stores individual messages
- `id` (uuid, primary key)
- `conversation_id` (uuid, foreign key)
- `role` (varchar, "user" or "assistant")
- `source` (varchar, "website", "doc-site", or "mobile"; default "website")
- `content` (text)
- `sources` (jsonb, null for user messages)
- `reaction` (varchar, null by default)
- `created_at` (timestamp)

### docsync tables

**docsync_sources** — Configured repositories and raw sources
- `id` (uuid, primary key)
- `owner` (varchar, required)
- `name` (varchar, required)
- `kind` (varchar, "repo" or "raw")
- `ref` (varchar, null for raw)
- `docs_root` (varchar, null)
- `base_url` (varchar)
- `created_at` (timestamp)
- `updated_at` (timestamp)

**docsync_chunks** — Indexed markdown chunks
- `id` (uuid, primary key)
- `source_id` (uuid, foreign key)
- `path` (varchar, file path or identifier)
- `title` (varchar)
- `url` (varchar)
- `content` (text, the chunk text)
- `vector` (vector, embeddings if enabled)
- `hash` (varchar, content hash)
- `created_at` (timestamp)
- `updated_at` (timestamp)

**docsync_indexes** — Index status per repository
- `id` (uuid, primary key)
- `source_id` (uuid, foreign key)
- `status` (varchar, "pending", "indexed", "failed")
- `error` (text, null if status != "failed")
- `indexed_at` (timestamp, null until indexed)
- `created_at` (timestamp)
- `updated_at` (timestamp)
