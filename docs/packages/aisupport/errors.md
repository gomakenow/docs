---
title: Error handling
description: Sentinel errors, recovery strategies, and debugging.
---

# Error handling

The aisupport package returns sentinel errors for common failure modes. Check error types in your handlers to respond appropriately.

---

## Chat errors

### ErrEmptyQuestion

The question is blank or contains only whitespace.

```go
resp, err := engine.Chat.Ask(ctx, req)
if errors.Is(err, aisupport.ErrEmptyQuestion) {
    http.Error(w, "Question cannot be empty", http.StatusBadRequest)
    return
}
```

**Recovery:** Prompt the user to provide a non-empty question.

### ErrQuestionTooLong

The question exceeds `MaxQuestionLen` runes (default 2000).

```go
if errors.Is(err, aisupport.ErrQuestionTooLong) {
    http.Error(w, "Question is too long. Max 2000 characters.", http.StatusBadRequest)
    return
}
```

**Recovery:** Either increase `MaxQuestionLen` in the config, or ask the user to shorten their question.

### ErrInvalidOwner

The owner's Kind is not `OwnerUser` or `OwnerGuest`, or the ID is blank.

```go
if errors.Is(err, aisupport.ErrInvalidOwner) {
    http.Error(w, "Invalid owner", http.StatusBadRequest)
    return
}
```

**Recovery:** Verify that the owner is built correctly:
- Kind is `OwnerUser` or `OwnerGuest`
- ID is a non-empty string

### ErrConversationNotFound

The conversation ID does not exist, or the owner does not match.

```go
if errors.Is(err, aisupport.ErrConversationNotFound) {
    http.Error(w, "Conversation not found", http.StatusNotFound)
    return
}
```

**Recovery:** Load the user's conversations with `engine.Chat.Conversations` and let them pick one, or start a new conversation.

### ErrRetrieveFailed

The retriever function returned an error.

```go
if errors.Is(err, aisupport.ErrRetrieveFailed) {
    log.Printf("Retrieval failed: %v", err)
    // The LLM was still called with no docs
    // The response might be less accurate but is still useful
    http.Error(w, "Documentation unavailable, but I'll answer from what I know", http.StatusOK)
    return
}
```

**Recovery:** 
- Check if your documentation engine is healthy (database connection, disk space)
- Retry the ask with exponential backoff
- Notify admins that retrieval is failing

### ErrLLMFailed

The LLM function returned an error.

```go
if errors.Is(err, aisupport.ErrLLMFailed) {
    log.Printf("LLM failed: %v", err)
    http.Error(w, "Unable to process your question at this time", http.StatusInternalServerError)
    return
}
```

**Recovery:**
- Check that your LLM provider (OpenRouter, OpenAI, etc.) is responding
- Verify API keys and rate limits
- Implement exponential backoff for retries
- Route to human support if retries fail

### ErrNilEngine

The engine is nil.

```go
if errors.Is(err, aisupport.ErrNilEngine) {
    log.Fatal("Engine was not initialized")
}
```

**Recovery:** Ensure `aisupport.Init` succeeded and the engine is stored globally or passed to handlers.

## Documentation errors

### docsyncerrors.ErrNilEngine

The docsync engine is nil.

```go
chunks, err := engine.Search(ctx, req)
if errors.Is(err, docsyncerrors.ErrNilEngine) {
    log.Fatal("Docs engine was not initialized")
}
```

**Recovery:** Ensure `docsync.New` succeeded and the engine is stored globally.

### docsyncerrors.ErrInvalidConfig

Missing required config fields (DB/DSN, WebhookSecret for push webhooks).

```go
engine, err := docsync.New(config)
if errors.Is(err, docsyncerrors.ErrInvalidConfig) {
    log.Fatalf("Config error: %v", err)
}
```

**Recovery:** Verify the config has required fields:
- Either `DB` or `DSN` (open connection)
- `WebhookSecret` if you are using GitHub webhooks

### docsyncerrors.ErrWebhookSignatureInvalid

The GitHub webhook signature does not match the secret.

```go
// In your webhook handler
handler := engine.Handler()
// If signature fails, handler returns 401 Unauthorized
```

**Recovery:**
- Verify the webhook secret matches GitHub's configuration
- Check that your environment variable is correct
- Ensure the webhook payload has not been modified in transit

### docsyncerrors.ErrRepositoryNotFound

The webhook identifies a repository not in the configured repos.

```go
// Webhook for mycompany/unknown-repo arrives
// Handler checks: is (mycompany, unknown-repo) in Repos?
// No → returns 404
```

**Recovery:**
- Add the repository to the `Repos` list if you want it indexed
- Or ensure the webhook is being sent to the correct host

### docsyncerrors.ErrSourceNotFound

You referenced a source (repo or raw) that does not exist.

```go
result, err := engine.UpsertRawPath(ctx, docsync.Source{Owner: "myapp", Name: "unknown"}, chunks)
if errors.Is(err, docsyncerrors.ErrSourceNotFound) {
    http.Error(w, "Source not found", http.StatusNotFound)
    return
}
```

**Recovery:** 
- Create the source with `CreateResource` first
- Or use `EnsureIndexRows` to create pending rows for all configured repos

---

## HTTP status mapping

Map errors to HTTP responses in your handlers:

```go
func askHandler(w http.ResponseWriter, r *http.Request) {
    resp, err := engine.Chat.Ask(r.Context(), req)
    
    if err == nil {
        json.NewEncoder(w).Encode(resp)
        return
    }
    
    // Check error type and respond
    switch {
    case errors.Is(err, aisupport.ErrEmptyQuestion), 
         errors.Is(err, aisupport.ErrQuestionTooLong),
         errors.Is(err, aisupport.ErrInvalidOwner):
        http.Error(w, err.Error(), http.StatusBadRequest)
        
    case errors.Is(err, aisupport.ErrConversationNotFound):
        http.Error(w, err.Error(), http.StatusNotFound)
        
    case errors.Is(err, aisupport.ErrRetrieveFailed),
         errors.Is(err, aisupport.ErrLLMFailed):
        log.Printf("Error: %v", err)
        http.Error(w, "Service unavailable", http.StatusInternalServerError)
        
    default:
        log.Printf("Unexpected error: %v", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
    }
}
```

---

## Debugging strategies

### Check logs

The package does not log; log errors in your handlers:

```go
resp, err := engine.Chat.Ask(ctx, req)
if err != nil {
    log.Printf("Ask failed: %v", err)
}
```

### Check database connectivity

```go
// Ping the database
err := db.WithContext(ctx).Raw("SELECT 1").Error
if err != nil {
    log.Fatal("Database unreachable:", err)
}
```

### Check LLM provider

```go
// Test the LLM function
resp, err := callOpenRouter(ctx, aisupport.LLMRequest{
    Messages: []aisupport.LLMMessage{
        {Role: "user", Content: "Hello"},
    },
})
if err != nil {
    log.Printf("LLM error: %v", err)
}
```

### Check documentation search

```go
// Test the retriever
chunks, err := docs.Search(ctx, docsync.SearchRequest{
    Query: "test",
    Limit: 5,
})
if err != nil {
    log.Printf("Search error: %v", err)
}
```

### Enable verbose logging

Wrap functions to log their calls:

```go
func loggingLLM(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    log.Printf("LLM call: conversation=%d, owner=%s, messages=%d", 
        req.ConversationID, req.Owner.ID, len(req.Messages))
    resp, err := callOpenRouter(ctx, req)
    log.Printf("LLM response: %d bytes, error=%v", len(resp.Content), err)
    return resp, err
}

engine, err := aichat.New(aichat.Config{
    LLM: loggingLLM,
    // ...
})
```

---

## Common issues and solutions

### "Service unavailable" errors

**Symptom:** ErrRetrieveFailed or ErrLLMFailed

**Causes:**
- LLM provider (OpenRouter, OpenAI) is down or rate-limiting
- Retriever database is offline or slow
- Network connectivity issue

**Solution:**
1. Check provider status page
2. Verify API keys and quotas
3. Add retry logic with exponential backoff
4. Route to human support as fallback

### "Conversation not found"

**Symptom:** User requests a conversation they should have access to

**Causes:**
- User ID changed (e.g., after account merge)
- Conversation owned by guest; user logged in without claiming it
- Conversation was deleted

**Solution:**
1. Call `ClaimGuestConversations` when guest logs in
2. Handle archiving gracefully (archived conversations still exist)
3. Show user their available conversations first

### "Question too long"

**Symptom:** User gets ErrQuestionTooLong

**Causes:**
- Default limit is 2000 runes (generous for most cases)
- User copied a very long prompt or document

**Solution:**
- Increase `MaxQuestionLen` if longer questions are expected
- Or guide users to ask shorter, more specific questions

### Poor answer quality

**Symptom:** Answers are vague, off-topic, or repeat the question

**Causes:**
- System prompt is unclear
- Insufficient or irrelevant documentation
- LLM model is weak
- Context budget too small

**Solution:**
1. Improve the system prompt with specific instructions
2. Review documentation search results: are they relevant?
3. Try a stronger LLM model (e.g., gpt-4 instead of gpt-3.5)
4. Increase `MaxContextChars` to include more docs

### High escalation rate

**Symptom:** Many answers marked "needs human"

**Causes:**
- System prompt too conservative (tells LLM to escalate too often)
- Questions outside documentation scope
- Documentation incomplete

**Solution:**
1. Review the system prompt; relax escalation criteria if appropriate
2. Add documentation for out-of-scope topics
3. Monitor which topics are escalated most often

---

## Error wrapping

The package wraps retrieval and LLM errors to distinguish them:

```go
resp, err := engine.Chat.Ask(ctx, req)
if errors.Is(err, aisupport.ErrRetrieveFailed) {
    // The retriever (docs.Search) failed
    // The question and LLM call were not attempted
}
if errors.Is(err, aisupport.ErrLLMFailed) {
    // The LLM function failed
    // The retriever succeeded (if configured)
}
```

Use `errors.Unwrap` to inspect the underlying error:

```go
if errors.Is(err, aisupport.ErrLLMFailed) {
    underlying := errors.Unwrap(err)
    log.Printf("LLM error: %v", underlying)
    // underlying might be: "connection timeout", "rate limit exceeded", etc.
}
```
