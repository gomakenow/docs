---
title: Analytics
description: Track usage, engagement, and system health with built-in analytics.
---

# Analytics

The aisupport system automatically tracks all conversations and messages. You can query this data to understand how users interact with your support chat, identify documentation gaps, and measure system health. Every thread, question, answer, and reaction is recorded in your database — you own the data completely.

This page shows how to access and use analytics.

---

## What gets tracked

Every user interaction creates records:

**Conversations:**
- When created and last updated
- Who owns it (signed-in user or guest)
- Whether it's archived

**Messages:**
- Questions asked by users
- Answers provided by the assistant
- Documentation chunks cited in answers
- User reactions (thumbs up, thumbs down)

**Engagement:**
- Which users return for more conversations
- How many conversations have only one question
- How often answers cite documentation

This data is aggregated into snapshots you can query by time window. No conversation contents are included — just counts and rates for privacy and performance.

---

## Loading analytics for a time window

Query data for a specific period:

```go
// Load the last 30 days
window, err := aisupport.ParseAnalyticsWindow("30", time.Now())
if err != nil {
    return err
}

snapshot, err := aisupport.Analytics(ctx, db, window)
if err != nil {
    return err
}

// snapshot contains aggregated metrics
fmt.Printf("Conversations: %d\n", snapshot.Conversations)
fmt.Printf("Questions: %d, Answers: %d\n", snapshot.Questions, snapshot.Answers)
fmt.Printf("Users: %d\n", snapshot.Users)
fmt.Printf("Likes: %d, Dislikes: %d\n", snapshot.Liked, snapshot.Disliked)
```

**Snapshot fields:**

- **Conversations** — Total threads created in the window
- **Messages** — Every stored message (questions + answers)
- **Questions** — User messages
- **Answers** — Assistant replies
- **Users** — Distinct signed-in owners
- **Liked / Disliked** — Assistant replies that received that reaction
- **Grounded** — Assistant replies that cited at least one documentation page
- **OneShot** — Conversations with exactly one user question
- **FirstReplySeconds** — Median time from first question to first assistant reply

**Rates** (computed metrics):

- **Handoff** — Share of conversations that asked for a person (nil if no conversations)
- **Satisfaction** — Likes among replies that were liked or disliked (nil if no reactions)
- **Reaction** — Share of assistant replies that received any reaction
- **Grounded** — Share of assistant replies that cited a page
- **Return** — Share of users who started more than one conversation
- **OneShot** — Share of conversations that had only one user question

All rates are `*float64` because they may be nil if the denominator is zero.

---

## Time windows

Common preset strings:

```go
window, _ := aisupport.ParseAnalyticsWindow("7", time.Now())    // Last 7 days
window, _ := aisupport.ParseAnalyticsWindow("30", time.Now())   // Last 30 days
window, _ := aisupport.ParseAnalyticsWindow("90", time.Now())   // Last 90 days
window, _ := aisupport.ParseAnalyticsWindow("365", time.Now())  // Last year
window, _ := aisupport.ParseAnalyticsWindow("730", time.Now())  // Last 2 years
window, _ := aisupport.ParseAnalyticsWindow("all", time.Now())  // All time
```

---

## Interpreting the metrics

Load the snapshot and check the rates:

```go
window, _ := aisupport.ParseAnalyticsWindow("30", time.Now())
snapshot, _ := aisupport.Analytics(ctx, db, window)

// What % of conversations needed human help?
if snapshot.Rates.Handoff != nil {
    fmt.Printf("Handoff rate: %.1f%%\n", *snapshot.Rates.Handoff*100)
} else {
    fmt.Println("No conversations yet")
}

// What % of rated answers did users like?
if snapshot.Rates.Satisfaction != nil {
    fmt.Printf("Satisfaction: %.1f%%\n", *snapshot.Rates.Satisfaction*100)
} else {
    fmt.Println("No reactions yet")
}

// What % of answers cited documentation?
if snapshot.Rates.Grounded != nil {
    fmt.Printf("Grounded: %.1f%%\n", *snapshot.Rates.Grounded*100)
} else {
    fmt.Println("No answers yet")
}
```

**What each metric tells you:**

**Handoff rate** — Share of conversations where the assistant asked for a person.
- High (>20%) — Many threads need escalation. Your documentation might be incomplete, or questions are outside scope.
- Low (<10%) — The AI handles most requests without human help. Good system design.
- Trend: Growing handoff means you're getting harder questions or your docs are becoming outdated.

**Satisfaction rate** — Likes among answers that were rated (denominator is likes + dislikes).
- High (>85%) — Users trust the AI's answers.
- Low (<70%) — Answers are not helpful. The model, system prompt, or documentation may need work.
- Nil — No users have rated answers yet.

**Grounded rate** — Share of answers that cited a documentation page.
- High (>90%) — The AI regularly backs answers with your docs. Good citation.
- Low (<50%) — The AI answers without documentation. Check if search is returning chunks.

**Reaction rate** — Share of answers that received any reaction.
- High (>30%) — Users actively provide feedback. You can measure satisfaction.
- Low (<10%) — Users don't rate answers. Consider making the feedback UI more visible.

**Return rate** — Share of signed-in users with multiple conversations.
- High (>40%) — Users return for follow-ups. Good engagement.
- Low (<20%) — Users ask once and leave. Check if threading works well or if answers are complete.

**OneShot rate** — Share of conversations with only one user question.
- High (>80%) — Conversations are short. Either the AI answers fully, or users don't follow up.
- Low (<50%) — Users ask multiple questions. They're having conversations, not just getting quick answers.

::: info
Rates are computed from the message and conversation counts. A nil rate means the denominator was zero (e.g., no reactions for satisfaction rate).
:::

---

## Tracking trends over time

Compare snapshots across windows to spot problems:

```go
windows := []string{"7", "30", "90"}
for _, preset := range windows {
    window, _ := aisupport.ParseAnalyticsWindow(preset, time.Now())
    snapshot, _ := aisupport.Analytics(ctx, db, window)
    
    handoff := 0.0
    if snapshot.Rates.Handoff != nil {
        handoff = *snapshot.Rates.Handoff * 100
    }
    
    fmt.Printf("%s days: %d conversations, handoff %.1f%%\n",
        preset, snapshot.Conversations, handoff)
}
```

**Watch for these trends:**

- **Growing handoff rate** — Questions are getting harder or docs are stale. Add documentation or improve the system prompt.
- **Dropping satisfaction** — Answers are getting worse. Check the LLM model or system prompt.
- **Falling grounded rate** — Answers are citing docs less. Check if search is working or if documentation is relevant.
- **Rising reaction rate** — Users are engaged. Good sign.
- **Steady usage** — The feature is valuable. Consider investing in it.
- **Declining usage** — Users stopped using chat. Either it doesn't work or they can't find it.

---

## Generating reports

Snapshots give you raw numbers. But raw numbers are hard to interpret. A 12% handoff rate — is that good? Grounded at 88% — should you improve docs?

Let the LLM read the snapshot and write a human-friendly report:

```go
window, _ := aisupport.ParseAnalyticsWindow("30", time.Now())

report, err := aisupport.GenerateAnalyticsReport(ctx, db, window, callOpenRouter)
if err != nil {
    return err
}

fmt.Println(report)
// Output example:
// "Support chat handled 1,243 conversations over 30 days.
//  User satisfaction is strong: 87% of rated answers got thumbs up.
//  The AI successfully answered 88% of questions without escalation.
//  88% of answers cited documentation, showing effective knowledge retrieval.
//  34% of users returned for follow-up conversations."
```

The `GenerateAnalyticsReport` function:
1. Loads the snapshot for the window
2. Formats metrics into a natural-language prompt
3. Calls your LLM to write a summary
4. Returns human-readable text

Use reports for:
- **Weekly summaries** — Email to your team every Monday
- **Executive briefings** — Show leadership how the feature is performing
- **Trend analysis** — Compare reports week-to-week to spot patterns
- **Handoff review** — Ask the LLM to identify which topics need better docs

The report is much more actionable than raw metrics.

---

## Building an admin dashboard

Expose analytics on an admin page:

```go
func adminAnalyticsHandler(w http.ResponseWriter, r *http.Request) {
    user, _ := auth.UserFromContext(r.Context())
    if !user.IsAdmin {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }
    
    // Get requested time window
    preset := r.URL.Query().Get("window")
    if preset == "" {
        preset = "30"
    }
    
    window, err := aisupport.ParseAnalyticsWindow(preset, time.Now())
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    // Load analytics
    snapshot, err := aisupport.Analytics(r.Context(), db, window)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Return JSON for frontend dashboard
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(snapshot)
}

router.HandleFunc("/admin/analytics", adminAnalyticsHandler)
```

Display on the frontend:
- Total conversations and messages
- User count and return rate
- Handoff rate trend
- Satisfaction percentage
- Grounded rate
- Buttons to switch time windows (7, 30, 90 days)
- Line chart of conversations over time
- Top documentation pages cited

---

## Finding documentation gaps

Questions that lead to handoff reveal documentation gaps. Run this SQL:

```sql
SELECT 
    SUBSTRING(m.content, 1, 100) as question,
    COUNT(DISTINCT m.conversation_id) as conversations_needing_handoff
FROM aisupport_messages m
WHERE m.role = 'user' AND EXISTS (
    SELECT 1 FROM aisupport_messages a 
    WHERE a.conversation_id = m.conversation_id 
    AND a.role = 'assistant'
    AND a.needs_human = true
)
GROUP BY question
ORDER BY conversations_needing_handoff DESC
LIMIT 10;
```

This shows the top questions that need human help. Use these insights to:
- Add FAQ entries for frequent questions
- Improve documentation for repeated topics
- Expand system scope or acknowledge limitations

---

## Caching analytics

Analytics queries scan large datasets. Cache the results:

```go
func cachedAnalytics(ctx context.Context, db *gorm.DB, preset string) (*aisupport.Snapshot, error) {
    cacheKey := "analytics:" + preset
    
    // Check cache (Redis, in-memory, etc.)
    if cached, ok := cache.Get(cacheKey); ok {
        return cached, nil
    }
    
    // Compute snapshot
    window, _ := aisupport.ParseAnalyticsWindow(preset, time.Now())
    snapshot, err := aisupport.Analytics(ctx, db, window)
    if err != nil {
        return nil, err
    }
    
    // Cache for 1 hour
    cache.Set(cacheKey, snapshot, time.Hour)
    
    return snapshot, nil
}
```

Refresh hourly or daily, not on every request.

---

## Series data

The snapshot includes daily breakdowns:

```go
snapshot, _ := aisupport.Analytics(ctx, db, window)

for _, day := range snapshot.Series {
    fmt.Printf("%s: %d conversations, %d messages\n",
        day.Time, day.Conversations, day.Messages)
}
```

Use series to build charts showing:
- Conversations per day
- Messages per day
- Trend lines
- Seasonal patterns

---

## Top users and pages

The snapshot includes high-level activity:

```go
// Most active signed-in users
for _, user := range snapshot.TopUsers {
    fmt.Printf("User %s: %d conversations, %d messages\n",
        user.OwnerID, user.Conversations, user.Messages)
}

// Most cited documentation pages
for _, page := range snapshot.TopPages {
    fmt.Printf("Page %s (%s): cited %d times\n",
        page.Title, page.Name, page.Citations)
}
```

Use this to:
- Identify power users
- Find which documentation is most valuable
- Prioritize doc updates

---

## Complete example

An admin analytics page:

```go
func adminAnalyticsHandler(w http.ResponseWriter, r *http.Request) {
    user, _ := auth.UserFromContext(r.Context())
    if !user.IsAdmin {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }
    
    preset := r.URL.Query().Get("window")
    if preset == "" {
        preset = "30"
    }
    
    window, _ := aisupport.ParseAnalyticsWindow(preset, time.Now())
    snapshot, _ := aisupport.Analytics(r.Context(), db, window)
    
    // snapshot contains everything: counts, rates, series, top users, top pages
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(snapshot)
}

router.HandleFunc("/admin/analytics", adminAnalyticsHandler)
```

The frontend renders:
- Metric cards (conversations, messages, users)
- Rate percentages with badges (green if good, yellow if warning)
- Line chart of activity over time
- Top users and pages tables
- Window selector buttons
- Links to deep analytics or raw data

This gives admins complete visibility into how the support chat is performing.
