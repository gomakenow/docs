---
title: Error handling
description: Understand when errors occur, what they mean, and how to recover.
---

# Error handling

The aisupport package returns sentinel errors for common failure modes. Errors fall into two categories: **validation errors** (your request was invalid) and **system errors** (something went wrong during execution). Knowing the difference helps you decide whether to retry, adjust config, or escalate.

---

## When errors occur

The `Ask` method is where most errors surface:

```go
resp, err := engine.Chat.Ask(ctx, req)
```

Before calling the LLM, the package validates the request. If validation fails, it returns immediately — no database writes, no LLM call. If validation passes but the LLM or retriever fails, execution errors occur mid-flow.

---

## Validation errors

These errors mean your request was malformed or violated a limit. Fix the request and retry.

### ErrEmptyQuestion

The question is blank or contains only whitespace.

```go
if errors.Is(err, aisupport.ErrEmptyQuestion) {
    http.Error(w, "Please ask a question", http.StatusBadRequest)
    return
}
```

**When it occurs:** The user submitted an empty message.

**Recovery:** Prompt the user to provide a non-empty question. The conversation is not created.

### ErrQuestionTooLong

The question exceeds `MaxQuestionLen` runes (default 2000).

```go
if errors.Is(err, aisupport.ErrQuestionTooLong) {
    http.Error(w, fmt.Sprintf("Question is too long. Max %d characters.", 2000), http.StatusBadRequest)
    return
}
```

**When it occurs:** The user pasted a very long error message or copied documentation.

**Recovery:** Either increase `MaxQuestionLen` in the config, or guide users to ask shorter questions. No database writes occur until validation passes.

### ErrInvalidOwner

The owner's Kind is not `OwnerUser` or `OwnerGuest`, or the ID is blank.

```go
if errors.Is(err, aisupport.ErrInvalidOwner) {
    http.Error(w, "Invalid owner", http.StatusBadRequest)
    return
}
```

**When it occurs:** The handler built the owner incorrectly (typo in Kind, empty ID, or missing auth context).

**Recovery:** Verify the owner is constructed correctly:
- `Kind` is exactly `aisupport.OwnerUser` or `aisupport.OwnerGuest`
- `ID` is a non-empty string (user ID, session token, etc.)

::: warning
The owner determines access control. Always extract it from the authenticated request context. Never accept it from user input.
:::

### ErrInvalidClient

The client is not `website`, `doc-site`, or `mobile`. An empty client is not this error. An empty client is stored as `website`.

```go
if errors.Is(err, aisupport.ErrInvalidClient) {
    http.Error(w, "Choose a valid source.", http.StatusBadRequest)
    return
}
```

**When it occurs:** The caller sent a source the package does not know, such as `desktop`.

**Recovery:** Send one of `website`, `doc-site`, or `mobile`. `ParseClient` checks the same values before `Ask`. No conversation or message is written.

### ErrConversationNotFound

The conversation ID does not exist, or the owner does not match.

```go
if errors.Is(err, aisupport.ErrConversationNotFound) {
    http.Error(w, "Conversation not found", http.StatusNotFound)
    return
}
```

**When it occurs:** The user tries to continue a conversation that doesn't exist, or the owner doesn't match (security boundary).

**Recovery:**
1. When a guest logs in, call `ClaimGuestConversations(guestID, userID)` to transfer their history
2. When returning conversations to a user, always verify the owner matches
3. Offer to start a new conversation if the old one is not found

::: info
The owner mismatch protects user privacy. A user cannot access another user's conversations, even if they know the ID.
:::

---

## Execution errors

These errors mean something went wrong while processing. They may be transient (retry with backoff) or permanent (fix config or ask for help).

### ErrRetrieveFailed

The retriever function (documentation search) returned an error.

```go
if errors.Is(err, aisupport.ErrRetrieveFailed) {
    log.Printf("Retrieval failed: %v", err)
    // The LLM was still called with no docs
    // The response might be less accurate but is still useful
    return
}
```

**When it occurs:**
- Documentation database is offline or unreachable
- Search query is malformed (shouldn't happen, but could if the retriever has a bug)
- Network timeout fetching doc chunks

**When the LLM is still called:** If retrieval fails after the question is validated, the package calls the LLM anyway with an empty doc list. The response may be less accurate, but it's better than no answer.

**Recovery:**
1. Log the underlying error: `errors.Unwrap(err)` shows the root cause
2. Check your documentation engine health (database connection, disk space)
3. Retry the ask with exponential backoff (503 errors are transient)
4. Notify admins that retrieval is failing; it may indicate a larger problem

### ErrLLMFailed

The LLM function returned an error.

```go
if errors.Is(err, aisupport.ErrLLMFailed) {
    log.Printf("LLM failed: %v", err)
    http.Error(w, "Unable to process your question", http.StatusInternalServerError)
    return
}
```

**When it occurs:**
- LLM provider (OpenRouter, OpenAI, Claude) is down or rejecting requests
- API key is invalid or expired
- Rate limit exceeded
- Network timeout

**Recovery:**
1. Log the underlying error for investigation
2. Check the provider's status page
3. Verify API keys and quotas in your environment
4. Implement exponential backoff and retry once or twice
5. If retries fail, route to human support or return a user-friendly error

::: tip
Wrap your LLM function with logging to track what's happening:

```go
func loggingLLM(ctx context.Context, req aisupport.LLMRequest) (aisupport.LLMResponse, error) {
    start := time.Now()
    resp, err := callOpenRouter(ctx, req)
    duration := time.Since(start)
    
    if err != nil {
        log.Printf("LLM error after %dms: %v", duration.Milliseconds(), err)
    } else {
        log.Printf("LLM success: %d tokens in %dms", len(resp.Content), duration.Milliseconds())
    }
    return resp, err
}
```

This makes debugging much easier.
:::

---

## Engine initialization errors

These errors occur during `Init` and mean your config is incomplete.

### ErrNilEngine

The chat or docs engine is nil.

```go
if errors.Is(err, aisupport.ErrNilEngine) {
    log.Fatal("Chat engine was not initialized")
}
```

**When it occurs:** `aisupport.Init` failed, but you tried to call `engine.Chat.Ask` anyway.

**Recovery:** Check that `aisupport.Init` succeeded before storing and using the engine.

---

## Documentation engine errors

The `Docs` engine (search, indexing, webhooks) has its own errors.

### ErrInvalidConfig

Missing required config fields (DB/DSN, WebhookSecret).

```go
docs, err := aisupport.NewDocs(config)
if errors.Is(err, docsyncerrors.ErrInvalidConfig) {
    log.Fatalf("Docs config incomplete: %v", err)
}
```

**When it occurs:** You passed an incomplete config to `NewDocs`.

**Recovery:** Ensure the config has:
- Either `DB` (reuse existing pool) or `DSN` (connection string)
- `WebhookSecret` if you're using GitHub webhooks

### ErrWebhookSignatureInvalid

The GitHub webhook signature does not match the secret.

```go
handler := engine.Docs.Handler()
// If signature fails, handler returns 401 Unauthorized
```

**When it occurs:** GitHub sends a webhook, but the signature doesn't match the secret you provided.

**Causes:**
- `WebhookSecret` in config doesn't match GitHub's setting
- Environment variable with the secret is missing or wrong
- The webhook payload was modified in transit (unlikely but possible)

**Recovery:**
1. Go to the repository settings → Webhooks → your webhook
2. Verify the "Secret" field matches your `WebhookSecret` config
3. Check your environment variable: `echo $GITHUB_WEBHOOK_SECRET`
4. Re-send the webhook from GitHub to test

### ErrRepositoryNotFound

The webhook identifies a repository not in your configured repos.

```go
// Webhook for mycompany/unknown-repo arrives
// Handler checks if (mycompany, unknown-repo) is in Repos
// Not found → returns 404
```

**When it occurs:** You configured repos A and B, but GitHub sent a webhook for repo C.

**Recovery:**
- Add repo C to the `Repos` list if you want it indexed
- Or remove the webhook from repo C in GitHub settings

### ErrSourceNotFound

You referenced a raw source (custom chunk set) that doesn't exist.

```go
result, err := engine.Docs.UpsertRawPath(ctx, aisupport.Source{Owner: "myapp", Name: "faq"}, chunks)
if errors.Is(err, docsyncerrors.ErrSourceNotFound) {
    log.Printf("Source not found: create it first with CreateResource")
}
```

**When it occurs:** You tried to index chunks for a source that wasn't declared in config or created yet.

**Recovery:**
- Call `CreateResource` to declare the source first, then `UpsertRawPath`
- Or include the source in `RawSources` when initializing the engine

---

## HTTP status mapping

Map errors to appropriate HTTP responses in your handlers:

```go
func askHandler(w http.ResponseWriter, r *http.Request) {
    resp, err := engine.Chat.Ask(r.Context(), req)
    
    if err == nil {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(resp)
        return
    }
    
    // Validation errors → 400 Bad Request
    if errors.Is(err, aisupport.ErrEmptyQuestion) ||
       errors.Is(err, aisupport.ErrQuestionTooLong) ||
       errors.Is(err, aisupport.ErrInvalidOwner) ||
       errors.Is(err, aisupport.ErrInvalidClient) {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    // Not found → 404
    if errors.Is(err, aisupport.ErrConversationNotFound) {
        http.Error(w, err.Error(), http.StatusNotFound)
        return
    }
    
    // System errors → 503 Service Unavailable (transient) or 500 (permanent)
    if errors.Is(err, aisupport.ErrRetrieveFailed) ||
       errors.Is(err, aisupport.ErrLLMFailed) {
        log.Printf("Error: %v", err)
        http.Error(w, "Unable to process your question", http.StatusInternalServerError)
        return
    }
    
    // Unexpected error
    log.Printf("Unexpected error: %v", err)
    http.Error(w, "Internal error", http.StatusInternalServerError)
}
```

---

## Debugging common issues

### "Service unavailable" errors

**Symptom:** ErrRetrieveFailed or ErrLLMFailed consistently

**Diagnosis:**
1. Check LLM provider status page (is OpenRouter/OpenAI up?)
2. Test the LLM function directly:
   ```go
   resp, err := callOpenRouter(ctx, aisupport.LLMRequest{
       Messages: []aisupport.LLMMessage{{Role: "user", Content: "Hello"}},
   })
   if err != nil {
       log.Printf("LLM test failed: %v", err)
   }
   ```
3. Verify API keys are set: `echo $OPENROUTER_KEY`
4. Check database connectivity: `psql -d $DATABASE_URL -c "SELECT 1"`

**Solution:**
- If provider is down, wait or switch to fallback provider
- If keys are wrong, fix environment variables and restart
- If network is slow, increase timeouts or add retries

### "Conversation not found" when it should exist

**Symptom:** User can't see a conversation they just created

**Diagnosis:**
1. Verify the owner in the continuation matches the owner in the ask:
   ```go
   // Ask
   resp1, _ := engine.Chat.Ask(ctx, aisupport.AskRequest{
       Owner: aisupport.Owner{Kind: aisupport.OwnerUser, ID: userID},
       Question: "How do I set up webhooks?",
   })
   
   // Follow-up
   resp2, _ := engine.Chat.Ask(ctx, aisupport.AskRequest{
       ConversationID: resp1.ConversationID,
       Owner: aisupport.Owner{Kind: aisupport.OwnerUser, ID: userID},  // Same owner
       Question: "Can I test locally?",
   })
   ```
2. Check the database: `SELECT id, owner_kind, owner_id FROM aisupport_conversations WHERE id = '<id>'`

**Solution:**
- Always verify the owner is the same for all operations on a conversation
- When a guest logs in, claim their conversations: `ClaimGuestConversations(guestID, userID)`

### Poor answer quality

**Symptom:** Answers are vague, off-topic, or wrong

**Diagnosis:**
1. Check what docs were retrieved:
   ```go
   chunks, _ := engine.Docs.Search(ctx, aisupport.SearchRequest{
       Query: "How do I set up webhooks?",
       Limit: 5,
   })
   log.Printf("Retrieved %d chunks", len(chunks))
   ```
   If retrieval returns empty or irrelevant chunks, the documentation is incomplete or not indexed.

2. Check the system prompt:
   ```go
   // Temporarily log the prompt being sent to the LLM
   // (Add logging in your LLM wrapper function)
   ```

3. Try a stronger LLM model (gpt-4 vs gpt-3.5)

**Solution:**
- Improve documentation: add missing pages, make titles more specific
- Increase `RetrieveLimit` to include more chunks
- Switch to a stronger LLM model
- Improve the system prompt with specific instructions about your domain

### High escalation rate

**Symptom:** Many answers say "needs human" / have `NeedsHuman = true`

**Diagnosis:**
1. Check which questions are escalated:
   ```sql
   SELECT message.content, COUNT(*) as count
   FROM aisupport_messages message
   WHERE role = 'assistant' AND needs_human = true
   GROUP BY message.content
   ORDER BY count DESC
   LIMIT 10;
   ```
2. Check if documentation exists for those topics

**Solution:**
- Add documentation for frequently escalated topics
- Review the system prompt: is it telling the LLM to escalate too conservatively?
- Monitor escalation rate in analytics to track improvements

---

## Error wrapping and investigation

The package wraps retrieval and LLM errors to help you debug:

```go
resp, err := engine.Chat.Ask(ctx, req)
if errors.Is(err, aisupport.ErrRetrieveFailed) {
    // Retriever failed; LLM was not called
    underlying := errors.Unwrap(err)
    log.Printf("Retrieval error: %v", underlying)
    // underlying might be: connection timeout, rate limit, database error, etc.
}
if errors.Is(err, aisupport.ErrLLMFailed) {
    // LLM call failed
    underlying := errors.Unwrap(err)
    log.Printf("LLM error: %v", underlying)
    // underlying might be: auth failed, model overloaded, context too long, etc.
}
```

Use `errors.Unwrap` to inspect the root cause. That's where the real error message lives.
