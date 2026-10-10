---
title: Chat and conversations
description: Store questions and answers, manage conversations, and build the chat UI.
---

# Chat and conversations

A conversation is a thread of related questions and answers. When a user asks a question, the package stores it, retrieves relevant documentation, calls your LLM, and stores the answer. You manage conversations: list them, load their messages, archive them when users are done.

This page shows you how to work with conversations end-to-end: asking questions, continuing threads, managing them as a user interacts with your support chat.

---

## Asking a question

When a user types a question and hits send, you call `Ask`:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: 0,  // 0 means start a new conversation
    Owner: aisupport.Owner{
        Kind: aisupport.OwnerUser,
        ID:   fmt.Sprintf("%d", user.ID),
    },
    Question: "How do I integrate webhooks?",
})
if err != nil {
    return err
}

// resp.ConversationID is the ID to save for follow-ups
// resp.Answer.Content is the assistant's reply
// resp.Answer.Sources are the documentation chunks cited
// resp.NeedsHuman is true if the LLM marked it for escalation
```

The `Ask` method:
1. Validates the question (non-empty, under length limit)
2. Validates the owner (must be OwnerUser or OwnerGuest with a non-empty ID)
3. Creates a new conversation (if ConversationID is 0) or loads the existing one
4. Stores the question
5. Retrieves documentation chunks
6. Assembles a prompt with system prompt, history, docs, and question
7. Calls your LLM function
8. Parses the response to extract citations and escalation markers
9. Stores the answer and sources
10. Returns everything to display to the user

All in one call. The user gets an instant response, and the conversation is saved.

---

## Understanding owners: Users and guests

Every conversation belongs to someone. The owner is a pair of values: a kind (either user or guest) and an ID.

**User owner** — Someone logged in. Use their user ID from your database:

```go
Owner{
    Kind: OwnerUser,
    ID:   fmt.Sprintf("%d", user.ID),  // String ID
}
```

User conversations persist. The user logs back in tomorrow and sees all their threads.

**Guest owner** — Someone not logged in. Use a session token, cookie value, or browser fingerprint:

```go
Owner{
    Kind: OwnerGuest,
    ID:   sessionToken,  // Unique per session
}
```

Guest conversations are temporary. They disappear when the session ends.

The owner determines access control. When you ask a question as user 42, that conversation is locked to user 42. If you later try to continue it as user 99, you get `ErrConversationNotFound`. This prevents users from viewing each other's conversations.

::: warning
The owner must match. Always verify that the owner in `Ask` is the same owner who created the conversation. Never construct an owner from untrusted input.
:::

---

## Continuing a conversation

After the user asks a follow-up, pass the conversation ID from the previous response:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: previousResponse.ConversationID,  // Continue, don't create new
    Owner: owner,  // Same owner as before
    Question: "Can I test webhooks in a sandbox?",
})
```

The package automatically loads the conversation's history (last 10 messages by default) and includes it in the LLM prompt. The LLM sees:
- The built-in system prompt
- The first Q&A
- The second question
- Your documentation

So it understands "Can I test this in a sandbox?" because it knows "this" refers to webhooks from the previous message. The context makes follow-ups natural.

::: tip
Always pass the same owner when continuing a conversation. If the user was logged out (guest), don't suddenly pass them as a user. Claim the conversation when they log in instead.
:::

---

## Converting guests to users

When a guest logs in, they should keep their conversation history. Move all their guest conversations to their user account:

```go
claimed, err := engine.Chat.ClaimGuestConversations(ctx, guestSessionID, userID)
if err != nil {
    return err
}
// claimed is the number of conversations transferred
```

This reassigns every conversation owned by `(OwnerGuest, guestSessionID)` to `(OwnerUser, userID)`. The messages don't change; only the owner is updated. Now when the user logs in and calls `Conversations`, they see all the questions they asked while logged out.

---

## Listing conversations

Show the user all their conversation threads. Load them with `Conversations`:

```go
conversations, err := engine.Chat.Conversations(ctx, owner, limit)
if err != nil {
    return err
}

for _, conv := range conversations {
    fmt.Printf("Conversation %d, last updated %s\n", conv.ID, conv.UpdatedAt)
}
```

Conversations are returned in order of most recently updated first. Use this to build a sidebar or conversation list. Pass `limit <= 0` to use the default (20).

Non-archived conversations only. Archived ones don't appear here, but you can still load them if you know the ID.

---

## Loading messages from a conversation

Once the user picks a conversation to view, load all its messages:

```go
messages, err := engine.Chat.Messages(ctx, owner, conversationID, limit)
if err != nil {
    return err
}

for _, msg := range messages {
    if msg.Role == "user" {
        fmt.Printf("You: %s\n", msg.Content)
    } else {
        fmt.Printf("AI: %s\n", msg.Content)
        for _, src := range msg.Sources {
            fmt.Printf("  📚 %s: %s\n", src.Title, src.URL)
        }
    }
}
```

Messages come back chronologically: oldest first, newest last. This is what you display in the chat UI.

Each message is either:
- **User message** — `Role: "user"`, `Content: question`, `Sources: empty`, `Reaction: empty`
- **Assistant message** — `Role: "assistant"`, `Content: answer`, `Sources: [...]`, `Reaction: empty or "like"/"dislike"`

Display sources below assistant answers. Sources are documentation chunks the LLM cited. Let users click through to the full docs.

::: info
Sources build trust. Users can verify answers came from your documentation and read the full context if they want.
:::

---

## Recording user feedback

After showing an answer, let the user react with "like" or "dislike":

```go
// User clicks the thumbs-up button
msg, err := engine.Chat.React(ctx, owner, messageID, "like")
if err != nil {
    return err
}

// User clicks the thumbs-down button
msg, err := engine.Chat.React(ctx, owner, messageID, "dislike")
if err != nil {
    return err
}

// User changes their mind (clears the reaction)
msg, err := engine.Chat.React(ctx, owner, messageID, "clear")
if err != nil {
    return err
}
```

The reaction is stored and returned. Use reactions to:
- Gather data on answer quality
- Let humans review disliked answers
- Identify topics where your documentation is weak
- Show aggregate metrics: "92% of users found this helpful"

::: info
Reactions are gold. They tell you which answers work and which don't. Check your analytics regularly to see which topics have low satisfaction.
:::

---

## Archiving conversations

When a user wants to delete a conversation, archive it instead of removing it:

```go
err := engine.Chat.ArchiveConversation(ctx, owner, conversationID)
if err != nil {
    return err
}
```

Archived conversations stay in the database but don't appear in `Conversations` results. They're hidden, not deleted. If you need to review or restore an old conversation, you can still load it with `Messages` if you know the ID.

::: warning
Archiving is not deletion. The data remains for compliance, analytics, or manual review. If you need to permanently delete conversations, you must delete the database rows directly.
:::

---

## History and context budgeting

When the user asks a follow-up, how much history does the LLM see?

**History limit** (default 10 messages) — The package sends the last 10 messages from the conversation to the LLM. More history = better context but higher token cost. Configure it:

```go
engine, err := aisupport.Init(aisupport.Config{
    Chat: aisupport.ChatConfig{
        HistoryLimit: 20,  // Include more history
        // ...
    },
    Docs: aisupport.DocsConfig{...},
})
```

**Context budget** (default 12000 bytes) — Documentation chunks are included in the prompt, but only up to a byte limit. If docs exceed the limit, earlier chunks are dropped, keeping only the most relevant:

```go
engine, err := aisupport.Init(aisupport.Config{
    Chat: aisupport.ChatConfig{
        MaxContextChars: 8000,  // Tighter budget, lower cost
        // ...
    },
    Docs: aisupport.DocsConfig{...},
})
```

The package keeps the conversation fast and within token budgets while preserving the most recent and relevant context.

---

## Validation and errors

### Empty or invalid questions

Questions must be non-empty and under the length limit (default 2000 runes):

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    Question: "",  // Blank
})
// err is ErrEmptyQuestion
// No conversation is created, no database write
```

If a question fails validation, the error is returned immediately. No LLM call, no database work.

### Invalid owner

The owner kind must be `OwnerUser` or `OwnerGuest`, and the ID must be non-empty:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    Owner: Owner{Kind: "invalid", ID: ""},  // Both wrong
})
// err is ErrInvalidOwner
```

### Conversation not found

If you reference a conversation ID that doesn't exist, or the owner doesn't match:

```go
resp, err := engine.Chat.Ask(ctx, aisupport.AskRequest{
    ConversationID: 999,  // Doesn't exist
    Owner: owner,
})
// err is ErrConversationNotFound
```

This prevents users from accessing conversations that aren't theirs.

### Retrieval or LLM failures

If your retriever or LLM function fails, `Ask` returns the error wrapped:

```go
resp, err := engine.Chat.Ask(ctx, req)
if errors.Is(err, ErrRetrieveFailed) {
    // Documentation search failed; retry or fallback
}
if errors.Is(err, ErrLLMFailed) {
    // LLM provider failed; retry with backoff
}
```

See [Error handling](./errors.md) for recovery strategies.

---

## Building a UI

Here's how to structure a typical chat interface:

**Sidebar (conversation list):**
```go
conversations, _ := engine.Chat.Conversations(ctx, owner, 0)
for _, conv := range conversations {
    fmt.Printf("Chat started %s\n", conv.CreatedAt)
}
```

**Main view (messages):**
```go
messages, _ := engine.Chat.Messages(ctx, owner, conversationID, 0)
for _, msg := range messages {
    if msg.Role == "user" {
        fmt.Printf("You: %s\n", msg.Content)
    } else {
        fmt.Printf("AI: %s\n", msg.Content)
        for _, src := range msg.Sources {
            fmt.Printf("  [%s](%s)\n", src.Title, src.URL)
        }
        // Show reaction buttons
    }
}
```

**Ask and append:**
```go
resp, _ := engine.Chat.Ask(ctx, AskRequest{
    ConversationID: currentConv,
    Owner: owner,
    Question: userInput,
})

// Save conversation ID for next ask
currentConv = resp.ConversationID

// Append to messages on screen
fmt.Printf("You: %s\n", userInput)
fmt.Printf("AI: %s\n", resp.Answer.Content)
for _, src := range resp.Answer.Sources {
    fmt.Printf("  [%s](%s)\n", src.Title, src.URL)
}

if resp.NeedsHuman {
    fmt.Printf("Connecting you to a human agent...\n")
}
```

---

## Complete example

A full user session:

```go
// 1. Guest asks a question
resp1, _ := engine.Chat.Ask(ctx, AskRequest{
    ConversationID: 0,  // New conversation
    Owner: Owner{Kind: OwnerGuest, ID: sessionToken},
    Question: "How do I set up webhooks?",
})
convID := resp1.ConversationID

// 2. Guest asks a follow-up (LLM has context from #1)
resp2, _ := engine.Chat.Ask(ctx, AskRequest{
    ConversationID: convID,
    Owner: Owner{Kind: OwnerGuest, ID: sessionToken},
    Question: "Can I test locally?",
})

// 3. Guest likes the answer
engine.Chat.React(ctx, Owner{Kind: OwnerGuest, ID: sessionToken}, resp2.Answer.ID, "like")

// 4. Guest logs in → claim their conversations
claimed, _ := engine.Chat.ClaimGuestConversations(ctx, sessionToken, userID)

// 5. User sees all their conversations (including the ones from steps 1-3)
conversations, _ := engine.Chat.Conversations(ctx, Owner{Kind: OwnerUser, ID: userID}, 0)

// 6. User loads that conversation
messages, _ := engine.Chat.Messages(ctx, Owner{Kind: OwnerUser, ID: userID}, convID, 0)

// 7. User archives it when done
engine.Chat.ArchiveConversation(ctx, Owner{Kind: OwnerUser, ID: userID}, convID)
```

This is the full cycle: new conversation, follow-up, reaction, claiming, listing, loading, archiving. Everything flows naturally.
