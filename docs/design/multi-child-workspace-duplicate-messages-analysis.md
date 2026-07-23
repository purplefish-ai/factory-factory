# Design Doc: Duplicate Parent↔Child Messages With Multiple Concurrent Child Workspaces

## Summary

When a parent workspace has several child workspaces active at the same time, users report that the same message appears to be sent more than once in both directions (parent→child and child→parent), and that this burns noticeably more tokens than expected. This doc is an investigation, not a confirmed fix: it lays out what the delivery pipeline actually does, what is already well-guarded, and the leading hypotheses for where the duplication comes from, ranked by how well the evidence supports them.

The single most important finding: **delivering a workspace notification live can block the calling tRPC mutation — and therefore the MCP tool call that triggered it — until the *entire downstream agent turn on the target workspace finishes*, for up to an hour.** Nothing in the existing, otherwise-careful de-duplication logic protects against what happens when an *external* caller (the requesting agent's own MCP client) gives up and retries before that hour is up. This is hypothesis H1 below, and it is the leading explanation for the token-cost complaint specifically.

## Update: H1 Confirmed Empirically (2026-07-23)

Running `scripts/check-child-notification-duplicates.sh` against a real affected instance's DB (120 notifications) **confirms H1** and rules out H2/H3 for the observed duplicates:

- **9 duplicate pairs found**, and in **all 9 both rows were delivered** (`both_delivered = 9`, `one_or_none = 0`) — i.e. every duplicate became a *real second agent turn* with real token cost, which is exactly the reported symptom.
- **Every gap clustered tightly at ~307–329s** — a fixed ~300s (5-minute) timeout plus a few seconds of retry/persist overhead. This is a mechanical client-level timeout firing, not an LLM deciding to resend (which would not recur at a precise 5-minute mark nine times). It corrects the earlier ~30–60s estimate: **the effective external MCP tool-call timeout is ~5 minutes.** Nothing on our side is 300s (our prompt timeout and tool watchdog are both 1 hour), so the timeout originates in the *sender's* external MCP client.
- **All 9 duplicates are `PARENT_TO_CHILD`; zero of the 64 `CHILD_TO_PARENT` rows duplicated.** This asymmetry is itself corroboration of the mechanism: duplication requires an *idle target with a long resulting turn*. Parent→idle-child hits that (child does long implementation work → parent's tool call blocks past 300s → times out → retry). Child→busy-parent does not (parent is mid-turn, so delivery just enqueues and returns fast via `getRequeueReason` → no block → no timeout → no duplicate).
- The duplicated messages are **substantive agent-authored instructions** with byte-identical text within each pair but distinct `id`s — not the fixed lifecycle strings H3 concerns, and distinct rows rather than the single-row redelivery H2 concerns. **H2 and H3 are ruled out for these cases.**

The remainder of this doc is preserved as the original pre-confirmation analysis.

## Problem Statement

- Symptom 1 (content): the same logical message ("child X says …", "parent says …") shows up more than once, either in the transcript UI or as repeated tool dispatches.
- Symptom 2 (cost): token usage is much higher than expected — consistent with the *target* agent actually re-processing the same instruction multiple times (a real extra turn), not just a rendering glitch.
- Trigger condition reported by the user: this happens specifically when **multiple child workspaces are in flight at once**, not (apparently) with a single child.

Because symptom 2 implies real extra agent turns (real token spend), a purely cosmetic UI double-render cannot be the whole story — something is causing the *target* session to actually receive and act on the same instruction more than once.

## System Overview (relevant path only)

```
child agent                         parent agent
   │ tool call: send_message_to_parent   │ tool call: send_message_to_child
   ▼                                     ▼
child-workspace-mcp-server.ts (stdio MCP subprocess, one per session)
   │ single fetch(), no retry, no timeout  (callTrpcMutation)
   ▼
workspace.sendMessageToParent / workspace.sendMessageToChild  (children.trpc.ts)
   ▼
deliverWorkspaceNotification()  (workspace-notification-delivery.orchestrator.ts)
   1. persist WorkspaceNotification row (always, unconditionally — new row, new id, every call)
   2. pick target workspace's most-recently-active RUNNING/IDLE session
   3. hasQueuedMessage(sessionId, messageId) — dedup by notification id, skip if already queued
   4. enqueue message + append/emit UI event
   5. await chatMessageHandlerService.tryDispatchNextMessage(sessionId)   ← blocking call, see H1
   ▼
tryDispatchNextMessage → dispatchHeadOfQueue → dispatchPeekedMessage → dispatchMessage
   → sessionService.sendSessionMessage → sendAcpMessage(sessionId, prompt, 1 hour timeout)
   → "The prompt() call blocks until the turn completes" (session.service.ts:306, verbatim comment)
```

Two independent delivery paths write into the same session queue and are reconciled by notification-id-keyed guards:
- **Live delivery** — the path above, triggered synchronously by the sender's tool call.
- **Session-start redelivery** — `deliverPendingChildNotifications()` in `session.lifecycle.service.ts`, run every time a session's ACP client (re)starts, which re-scans all undelivered `WorkspaceNotification` rows for that workspace.

## What Is Already Well-Guarded (ruled out)

Before getting to hypotheses, it's worth being explicit about what several rounds of prior fixes (#1711, #1844, #1885, #1897, #1904, #1960 — all closed) already handle correctly, so effort isn't wasted re-litigating these:

- **Notification-id-based dedup at enqueue time** — `sessionDomainService.hasQueuedMessage(sessionId, messageId)`, checked in both delivery paths, keyed by a deterministic id derived from the `WorkspaceNotification.id`.
- **Cross-session double-dispatch guard** — `chatMessageHandlerService.inFlightNotificationDeliveries` (a synchronous, no-`await`-in-between claim map) plus `isNotificationRowDelivered()` DB check prevents the *same* notification row from being sent to the provider twice, even if it got enqueued onto two different sessions of the same workspace by the two delivery paths racing each other. This is explicitly documented in code comments as defending against exactly the "persist-first delivery enqueues the same notification on two sessions" race.
- **Transport/WebSocket fan-out** — verified there is no duplicate-listener registration and no "broadcast to all sessions" path in the event bus / chat transport for these messages; a notification is emitted to exactly the one target session.
- **MCP server itself does not fan out** — one MCP subprocess per ACP session, `send_message_to_child` addresses exactly one `childWorkspaceId` per call; there's no loop in the MCP server or in `workspace-children.orchestrator.ts` that iterates over multiple children and re-sends the same content.

All of this machinery is **keyed by `WorkspaceNotification.id`**. That's the important caveat for what follows: it can only deduplicate *re-deliveries of the same row*. It does nothing if two distinct rows get created for what is semantically the same message.

## Hypotheses (ranked by confidence)

### H1 — Long-blocking live delivery causes an external timeout → agent retries the tool call → new, undeduplicable row (leading hypothesis)

**Mechanism:**
`deliverWorkspaceNotification` `await`s `chatMessageHandlerService.tryDispatchNextMessage(...)` before the tRPC mutation returns (workspace-notification-delivery.orchestrator.ts:105). If the target session is currently **idle**, `tryDispatchNextMessage` proceeds to actually dispatch, which calls `sessionService.sendSessionMessage` → `sendAcpMessage`, and per the code's own comment this "blocks until the turn completes" (session.service.ts:306), with a timeout of `DEFAULT_USER_PROMPT_TIMEOUT_MS = 60 * 60 * 1000` (one hour, session.service.ts:36).

So: a child calling `send_message_to_parent` while the parent is idle does not get a quick "ok, queued" response. Its MCP tool call blocks — through `callTrpcMutation`'s single `fetch()` with no client-side timeout (child-workspace-mcp-server.ts:120-143) — for as long as the **parent's entire resulting turn** takes to finish, up to an hour. The same is true in reverse for `send_message_to_child`.

Our own backend is internally consistent about this — the ACP tool-call watchdog in `acp-event-processor.ts` (`DEFAULT_TOOL_CALL_TIMEOUT_MS = 3_600_000`, i.e. also 60 minutes) is deliberately aligned with the 1-hour prompt timeout. But the **calling agent process** (the external `claude-agent-acp` / Claude Code MCP client subprocess, or the Codex adapter) is not part of this codebase and is not guaranteed to wait an hour for a tool result. Claude Code's MCP client is widely documented to apply its own tool-call timeout (configurable via `MCP_TIMEOUT`, on the order of tens of seconds by default) independent of anything our server does. If that external timeout fires while our mutation is still blocked waiting for the target's turn to finish, the calling agent sees a failed/timed-out tool call and — per normal LLM tool-use behavior — is very likely to retry it, believing the message was never sent.

Because `persistChildNotification` / `persistParentNotification` create a brand-new `WorkspaceNotification` row on *every* call with no idempotency key (workspace-children.orchestrator.ts:89-144), the retried call produces a **second, independent row** with a new id. Every dedup mechanism described above is keyed off `notification.id`, so this second row sails straight through `hasQueuedMessage`, `inFlightNotificationDeliveries`, and `isNotificationRowDelivered` as a legitimate, distinct message — and gets dispatched as a second real turn on the target session. That is a genuine duplicate agent turn, not a UI artifact, and matches the "blows a lot of tokens" complaint precisely.

**Why this correlates with "multiple children at once":** with only one child, the parent is usually either idle-and-fast to respond or the exchange is naturally serialized. With several children active concurrently:
- The parent is more likely to be mid-turn processing one child's message when it also wants to message another child, and vice versa, so more of these live-delivery calls land on an *idle* target (more opportunities to trigger the long block) rather than a busy one (which returns fast, see H1 caveat below).
- The parent's own turns tend to be longer (it's coordinating N children, possibly fanning out more `send_message_to_child` calls from within a single turn — each of which is itself a blocking call, so the parent's turn duration compounds with each child it messages).
- More concurrent long-blocked HTTP mutations increase general backend load (DB contention, event-loop pressure from N concurrent ACP subprocess I/O), which increases latency even for calls that would otherwise return quickly, making external timeouts more likely across the board.

**Caveat:** if the target session is already `working` (mid-turn) when the notification arrives, `getRequeueReason` returns `'working'` and dispatch is skipped for now (chat-message-handlers.service.ts:715-729) — the mutation returns quickly with the message merely enqueued. So the multi-hour block is specifically an "idle target" scenario, not universal. This actually strengthens the "more children → more idle-target hits" argument above.

**Suggested validation:** correlate `acp-event-processor.ts`'s `"Tool call timed out"` warning logs (or absence thereof, if the *external* client times out before our internal 60-minute watchdog would ever fire) with timestamps of duplicate `WorkspaceNotification` rows that share the same `sourceWorkspaceId`/`targetWorkspaceId` and near-identical `message` text but different `id`s and `createdAt` values a small time apart. Also worth directly timing `callTrpcMutation`'s `fetch()` in the MCP server subprocess (it currently has no instrumentation) to see actual observed latencies under multi-child load.

### H2 — Session-start redelivery race across multiple sessions of the same workspace

**Mechanism:** `deliverPendingChildNotifications` re-scans *all* undelivered `WorkspaceNotification` rows for a workspace (`listPendingForDelivery(workspaceId)`, not scoped to a session) every time that workspace's ACP client (re)starts (session.lifecycle.service.ts:1099-1214). If two sessions belonging to the same workspace both start around the same time — plausible when a user has several child workspaces each reconnecting/restarting concurrently, or a flaky ACP process is bouncing — both can enqueue the same still-undelivered row onto two different session queues before either has committed the message and called `markDelivered`.

This is a **known and partially, deliberately guarded** race — the code comment on `inFlightNotificationDeliveries` (chat-message-handlers.service.ts:96-105) says exactly this: *"persist-first delivery can enqueue the same notification on two sessions."* The guard closes most of the window, but by the authors' own admission it fails open: `isNotificationRowDelivered`'s comment states *"Fail open: a duplicate delivery is better than a lost message"* (chat-message-handlers.service.ts:673-674), and the claim can be released early by `resetDispatchState` on a concurrent stop/restart while a send from the *other* session may still be in flight (chat-message-handlers.service.ts:154-162).

**Why this correlates with "multiple children at once":** more children plausibly means more concurrent session churn (restarts, reconnects, idle timeouts) across the fleet, and every workspace with more than one open chat session raises the odds of hitting this specific window.

**Relative confidence:** lower than H1 for explaining the *token-cost* complaint specifically, because this path is explicitly guarded (fails open only in a narrow race window), whereas H1 has no guard at all once a second row exists. Still a plausible contributor, especially to the "same message visibly twice in the UI" symptom.

### H3 — Non-atomic read-compare-write in `syncPRStatus` creates two independent lifecycle-notification rows

**Mechanism:** `workspaceQueryService.syncPRStatus` (workspace-query.service.ts:375-399) reads `previousPrState` from the DB, fetches fresh PR state from GitHub, and if they differ, the caller (`workspace.trpc.ts:497-515`) fires a lifecycle notification via `fireLifecycleNotification` → `persistChildNotification`. There is no claim/lock around this read-compare-fire sequence (unlike the scheduler's periodic PR sync, which does use `prFetchRegistry.startFetch`/`isRecentlyFetched` to prevent concurrent fetches for the same workspace). If `syncPRStatus` is invoked twice concurrently for the same child workspace — plausible if the workspace detail view is open for that child while the periodic scheduler also ticks, or if a user has multiple children's detail panels open — both calls can read the same stale `previousPrState`, both observe the transition, and both fire a lifecycle notification. Since each call creates its own new row, this produces two independent rows with identical text ("A pull request has been opened." / "The pull request has been merged."), which — like H1 — is invisible to id-keyed dedup because it never was one row to begin with.

**Why this correlates with "multiple children at once":** more children means more PRs being polled/viewed concurrently, proportionally increasing the odds of two `syncPRStatus` calls racing for the same child.

**Relative confidence:** plausible but narrower in scope — only applies to automatic PR-lifecycle notifications, not to the agent-authored `send_message_to_child`/`send_message_to_parent` messages the user is most likely describing. Worth ruling in/out separately.

### H4 — `delivered: true` conflates "enqueued" with "actually dispatched" (minor, may compound H1)

**Mechanism:** `deliverWorkspaceNotification` returns `{ delivered: true }` as soon as the message is enqueued and the UI event is emitted — *before* knowing whether `tryDispatchNextMessage` actually sent anything (it may have silently no-op'd because the target session was busy, see `getRequeueReason`). The MCP server reports this back to the calling agent as "delivered live" (child-workspace-mcp-server.ts:255-263). This isn't itself a duplication bug, but it means the calling agent has no reliable signal to distinguish "your message is queued and will be handled soon" from "your message was actually acted on" — which may make an agent more inclined to re-send if it's unsure whether something happened, compounding H1's retry pressure. Worth noting for completeness; not a primary suspect on its own.

## Non-Goals / Explicitly Ruled Out

- No evidence of an MCP-server-side fan-out bug (one child ≠ multiple sends).
- No evidence of WebSocket/event-bus duplicate delivery to multiple browser clients being mistaken for duplicate parent/child messages (that layer is correctly scoped to one emit per target session).
- No retry loop exists in `child-workspace-mcp-server.ts`'s own `fetch()` calls — any retry has to originate either from the calling agent/MCP client (H1) or from an un-atomic read-compare-write on our side (H3).

## Validating H1

H1 is a *causal chain* — block → external timeout → agent retry → new undeduplicable row → real extra turn. Any single link failing kills the hypothesis, so each link is validated independently rather than trying to catch the whole thing end-to-end at once. The links are numbered as they appear in the H1 mechanism above.

### Link 4 first — "duplicate rows actually exist in the DB" (retrospective, zero code)

This is the smoking gun and needs no instrumentation. The `WorkspaceNotification` schema carries everything required: `sourceWorkspaceId`, `workspaceId`, `direction`, `message`, `createdAt`, and distinct `id`s.

```sql
-- Near-identical notifications: same source→target, same text, distinct rows, close in time
SELECT a.workspace_id, a.source_workspace_id, a.direction, a.message,
       a.id AS id_1, b.id AS id_2,
       a.created_at AS t1, b.created_at AS t2,
       (julianday(b.created_at) - julianday(a.created_at)) * 86400 AS gap_seconds
FROM workspace_notifications a
JOIN workspace_notifications b
  ON a.workspace_id = b.workspace_id
 AND a.source_workspace_id = b.source_workspace_id
 AND a.direction = b.direction
 AND a.message = b.message
 AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
 AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 >= 0
 AND (julianday(b.created_at) - julianday(a.created_at)) * 86400 < 600
ORDER BY t1;
```

- **Zero rows** → This rules out only byte-identical pairs found within the selected time window; H1/H3 require additional evidence to be falsified, and remaining duplication is not necessarily limited to H2.
- **Rows returned** → the `gap_seconds` distribution is itself diagnostic. Retries clustered at a consistent gap (e.g. all ~30–60s apart) strongly implies a fixed external timeout firing, which is the heart of H1. Byte-identical `message` text is the key signal — a coordinating agent almost never re-emits byte-identical prose by chance, so identical text ≈ mechanical retry, not the LLM independently choosing to send again.

Run this before touching any code; it can falsify H1 outright or justify the instrumentation below.

### Link 1 — "the mutation blocks for the full target turn when the target is idle"

The load-bearing claim, currently only *inferred* from `session.service.ts:306` ("blocks until the turn completes") plus the 1-hour `DEFAULT_USER_PROMPT_TIMEOUT_MS`. Confirm directly:

1. In `deliverWorkspaceNotification` (`workspace-notification-delivery.orchestrator.ts:105`), wrap the `await chatMessageHandlerService.tryDispatchNextMessage(...)` with start/end timestamps and log the target session's status *at call time* (idle vs working) plus elapsed ms. Prediction: a sharp bimodal split — fast (<~100ms) when the target was `working` (dispatch no-ops via `getRequeueReason`), very long (seconds-to-turn-length) when idle.
2. In the MCP server's `callTrpcMutation` (`child-workspace-mcp-server.ts:120`), log `Date.now()` deltas around the `fetch()`. This is the latency the *external agent* actually experiences — the number that determines whether its client times out — and it is currently completely un-instrumented.

If the idle-target path returns quickly, H1 collapses. If it shows multi-second/multi-minute blocks, link 1 holds.

### Links 2 & 3 — "external MCP client times out, then the agent retries"

This part lives outside our codebase (the `claude-agent-acp` binary / Codex adapter is the MCP *client* that spawns and calls our server).

- **What timeout does the external client apply?** The MCP server subprocess inherits env from `childProcessEnvProvider()` (`acp-runtime-manager.ts:278`), so `claude-agent-acp` runs with the backend's env. Determine whether it honors `MCP_TIMEOUT` (Claude Code's MCP client default is on the order of tens of seconds, far below our 1-hour internal watchdog). If it's ~30–60s, that lines up with the `gap_seconds` clustering from link 4.
- **Does a timeout produce a retry, and does our watchdog stay silent?** Our own tool-call watchdog (`acp-event-processor.ts`, `DEFAULT_TOOL_CALL_TIMEOUT_MS = 3_600_000`, 60 min) emits a `"Tool call timed out"` warning — but if the *external* client times out first (say at 30s), our watchdog **never fires**. Duplicate rows appearing **without** a corresponding `"Tool call timed out"` warning in our logs is therefore consistent with the external client timing out below our threshold. Correlate duplicate-row timestamps (link 4) against presence/absence of that warning.

### Link 5 — "the second row becomes a real extra turn (the token cost)"

Confirm the duplicate isn't merely stored-but-dropped. For each duplicate `id` pair from link 4, check that both got `deliveredAt` set (both went through dispatch) and both appear as distinct dispatched user messages in the target session's transcript. Both delivered + dispatched → two real turns → real token spend (the actual complaint). If the second row stayed `deliveredAt = null`, the dedup caught it and the cost must come from elsewhere.

### Decisive controlled reproduction

If retrospective evidence is suggestive but not conclusive, force it deterministically:

1. Parent workspace, one idle child; inflate the target turn by giving the child a task that keeps it working longer than the suspected external timeout (a couple of minutes).
2. From the parent, call `send_message_to_child`. Watch the MCP `fetch()` timing (link 1) confirm the block, and watch for the external client's timeout.
3. Observe whether a **second** `WorkspaceNotification` row appears with identical `message`, and whether the child processes the instruction twice.

As an unambiguous knob: temporarily set `MCP_TIMEOUT` low (a few seconds) in the backend env — if duplicates appear reliably at the low timeout and vanish when it's set high, that is causal proof that the external-timeout-then-retry link is the driver.

## Fix (implemented 2026-07-23)

The H1 fix turned out to be small and localized, not the architectural rework this section originally anticipated. The turn-blocking `await` was reachable from exactly one HTTP-bound caller (the `sendMessageTo{Child,Parent}` tRPC mutations behind the child-workspace MCP client); every other caller of `tryDispatchNextMessage` is a WebSocket handler or background init flow where blocking for the turn is harmless.

**Change:** in `deliverWorkspaceNotification` (`workspace-notification-delivery.orchestrator.ts`), the `await chatMessageHandlerService.tryDispatchNextMessage(activeSession.id)` became a detached, fire-and-forget call with a `.catch` that logs a warning. The function now returns `{ delivered: true }` as soon as the notification is durably persisted, enqueued, and its UI event emitted — the mutation no longer holds the caller's MCP tool call open for the target's turn, so the external ~5min timeout never fires and no retry/duplicate row is created.

- The `{ delivered: boolean }` contract and the MCP tool response text are unchanged; `delivered: true` now means "enqueued and dispatch started" rather than "…and turn finished."
- Two regression tests were added: delivery resolves even when the dispatched turn never settles, and a rejected detached dispatch does not reject the mutation (it logs a warning instead).
- In-flight detached turns that are abandoned by a mid-turn process restart are still redelivered via the existing `deliverPendingChildNotifications` session-start path (keyed on `deliveredAt IS NULL`), so durability is unaffected.

**Not implemented (optional backstop):** content-level idempotency in `persist{Parent,Child}Notification` (skip creating a row when an undelivered/recently-delivered row with the same `(workspaceId, sourceWorkspaceId, direction, message)` already exists). The core fix removes the retry that produces duplicates, so this is defense-in-depth rather than a requirement.

**Unaddressed (separate concerns, not observed in the confirmed data):** H2 (session-start redelivery race — add a conditional claim release in `resetDispatchState`) and H3 (non-atomic `syncPRStatus` read-compare-fire — add a claim/lock mirroring `prFetchRegistry`). Both were ruled out for the observed duplicates but remain latent.
