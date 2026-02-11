# Pitfalls Research

**Domain:** In-memory project snapshot service with event-driven deltas and WebSocket push
**Researched:** 2026-02-11
**Confidence:** HIGH (based on codebase analysis + established event-driven architecture patterns)

## Critical Pitfalls

### Pitfall 1: Snapshot Store Leaks Memory on Workspace Lifecycle Transitions

**What goes wrong:**
The snapshot store accumulates entries for workspaces that have been archived or deleted. The existing `WorkspaceActivityService` already tracks per-workspace state in a `Map<string, WorkspaceActivityState>` and has a `clearWorkspace()` method, but the archive orchestrator (`workspace-archive.orchestrator.ts`) does not call it -- it is only called in tests. A new snapshot store that mirrors this pattern will leak identically unless cleanup is wired at every lifecycle exit point.

**Why it happens:**
In-memory Maps in Node.js grow silently. There is no MaxListenersExceededWarning equivalent for Maps. Developers wire the "happy path" (create workspace -> populate snapshot) but forget the teardown paths: archive, delete, failed provisioning cleanup, and server restart recovery. The existing codebase has this exact pattern: `workspaceStates` in `activity.service.ts` has a `clearWorkspace` method, but the orchestration layer only clears it inconsistently.

**How to avoid:**
- Wire snapshot cleanup into `workspace-archive.orchestrator.ts` and any delete path as a hard requirement during implementation.
- Add a periodic sweep (piggyback on the existing scheduler cadence) that removes snapshot entries for workspaces no longer in READY/PROVISIONING status.
- Write a unit test that creates a snapshot, archives the workspace, and asserts the snapshot map no longer contains the entry.
- Set a hard upper bound on snapshot store size (e.g., 500 entries) with LRU eviction as a safety net.

**Warning signs:**
- `process.memoryUsage().heapUsed` grows monotonically over days without leveling off.
- Snapshot store `.size` exceeds active workspace count by more than 20%.
- No test covers the archive-clears-snapshot path.

**Phase to address:**
Phase 1 (Core Snapshot Store). Define cleanup contract as part of the store interface from day one. Do not defer cleanup to a later phase.

---

### Pitfall 2: Event Ordering Races Between Mutation Sources

**What goes wrong:**
Multiple mutation sources update the same workspace snapshot concurrently: the scheduler's PR sync, a user-triggered manual PR refresh via tRPC, the ratchet service's CI monitoring, and session lifecycle events from the chat event forwarder. Without a sequencing mechanism, a stale PR sync result that was initiated before a manual refresh can overwrite the newer manual refresh result. The existing codebase already demonstrates this risk: `prSnapshotService.refreshWorkspace()` is called from both the scheduler (`syncSinglePR`) and the workspace query service (`syncPRStatus`), with no coordination between them.

**Why it happens:**
Each mutation source independently reads state, performs an async operation (e.g., GitHub API call), and writes back. The classic read-modify-write race. In-memory stores make this worse because there is no database-level optimistic locking to catch conflicts.

**How to avoid:**
- Apply a version counter or timestamp to each snapshot field cluster (e.g., `prStateVersion`, `sessionStateVersion`). On write, compare-and-swap: reject the update if the version is stale.
- Alternatively, use a single-writer pattern per field cluster: only the scheduler writes PR state, only the session event forwarder writes session state. The snapshot service becomes a reader that aggregates, never a writer that arbitrates.
- For the reconciliation poll (safety-net), always treat poll results as lower priority than event-driven updates. Only apply poll results when `lastEventTimestamp < pollInitiatedAt`.

**Warning signs:**
- Workspace sidebar flickers between two states (e.g., CI_PASSING then CI_RUNNING then CI_PASSING again).
- State reverts to an older value briefly before settling.
- Logs show two snapshot updates for the same workspace within milliseconds.

**Phase to address:**
Phase 1 (Core Snapshot Store). The store must define its concurrency model before any writers are connected.

---

### Pitfall 3: Breaking Domain Boundaries via Shared Event Types

**What goes wrong:**
The snapshot service needs data from all 6 domains (session state, workspace lifecycle, GitHub PR status, ratchet state, git changes, terminal state). The temptation is to define a shared event type that all domains emit, or to have the snapshot service import from domain internals. Either approach violates the existing `no-cross-domain-imports` rule enforced by dependency-cruiser, and creates coupling where domains must know about the snapshot service's data model.

This codebase has a strict architectural pattern: domains export barrel files only, cross-domain coordination uses bridge interfaces wired in `domain-bridges.orchestrator.ts`. The snapshot service must follow this pattern or it will become the "god object" that couples everything together.

**Why it happens:**
Event-driven systems create a false sense of decoupling. The events themselves become a shared schema -- if domain A changes its event shape, the snapshot service breaks. This is "semantic coupling" through events, and it is the most common pitfall in event-driven architectures at scale (per Wix Engineering and Confluent's documented experiences).

**How to avoid:**
- Place the snapshot service in `src/backend/services/` (infrastructure-level), not in a domain. It aggregates data but owns no domain logic.
- Define snapshot bridge interfaces in each domain that the orchestration layer wires, exactly like the existing `RatchetSessionBridge`, `WorkspaceSessionBridge`, etc. The snapshot service never imports from domain barrels.
- Each domain emits domain-native events (e.g., workspace domain emits `status_changed`, session domain emits `session_idle`). The orchestration layer translates these into snapshot updates. The snapshot service receives pre-mapped data, not raw domain events.
- Run `pnpm dependency-cruiser` in CI to verify no cross-domain imports are introduced.

**Warning signs:**
- Import paths in the snapshot service contain `@/backend/domains/` (should only have `@/backend/services/`).
- Snapshot service defines its own types that mirror domain types (duplicate type definitions).
- A change in one domain's internal types causes snapshot service compilation failures.
- dependency-cruiser violations appear in CI.

**Phase to address:**
Phase 1 (Architecture Design). The bridge interfaces must be defined before any event wiring begins. This is a design decision, not an implementation detail.

---

### Pitfall 4: WebSocket Reconnection Drops State Updates

**What goes wrong:**
When a client's WebSocket disconnects and reconnects (tab sleep, network blip, laptop lid close), events emitted during the disconnection window are lost. The client's UI shows stale state until the next polling cycle (if polling is kept) or indefinitely (if polling is removed). The existing chat WebSocket has this exact vulnerability: `chatConnectionService.forwardToSession()` simply skips sessions with no open connections, with no buffering or replay.

The current system "solves" this through client-side polling (refetchInterval at 5-15s cadences across sidebar, Kanban, and workspace list). If the snapshot service replaces polling, this safety net disappears, and WebSocket gaps become directly visible to users.

**Why it happens:**
WebSocket push is fire-and-forget by default. The server has no confirmation that the client received the message. During reconnection, there is a window where the connection is not yet established but events are being emitted. Mattermost documented this exact issue: without a `missedMessageListener`, their WebSocket client entered infinite reconnection loops.

**How to avoid:**
- Do NOT remove client-side polling in the same phase as adding WebSocket push. Keep polling as a fallback with a relaxed cadence (30-60s) while the WebSocket push path is proven reliable.
- On WebSocket reconnect, the client must request a full snapshot (not just subscribe to deltas). The server should have a `getSnapshot(workspaceId)` endpoint that returns the current materialized state.
- Include a monotonic version number in each snapshot push. On reconnect, the client sends its last-seen version. If the server's current version is higher, it sends a full snapshot.
- Keep the reconciliation poll on the server side (~1 min cadence as planned) to heal any event delivery failures.

**Warning signs:**
- Sidebar shows "working" but the session finished minutes ago.
- Kanban board does not update after a laptop wake from sleep.
- Users report they need to refresh the page to see current state.
- No test covers the reconnect-then-resync flow.

**Phase to address:**
Phase 3 (WebSocket Integration). The reconnection protocol must be designed before the first WebSocket push message is sent. But do NOT remove polling until Phase 4 or later, after WebSocket push has been validated in production use.

---

### Pitfall 5: Reconciliation Poll and Event-Driven Updates Fight Each Other

**What goes wrong:**
The safety-net reconciliation poll runs every ~60 seconds and reads authoritative state from the database and external sources (GitHub API, git status). Event-driven updates arrive in real-time from domain mutations. If the reconciliation poll is not carefully coordinated with the event stream, the two sources oscillate: the event sets state to X, the poll (which started before the event) sets it back to the old state, then the next event sets it to X again. The UI flickers.

This is particularly dangerous for fields derived from slow external calls. The existing `getProjectSummaryState()` method in `workspace-query.service.ts` already performs concurrent git stat operations and GitHub API calls that take 100-500ms each. A reconciliation poll doing similar work can easily return results that are stale relative to events that arrived during the poll execution.

**Why it happens:**
The reconciliation poll and event system have different temporal semantics. Events are point-in-time mutations. Polls are interval snapshots that sample state at poll-start-time but apply results at poll-end-time. The gap between start and end is where races live.

**How to avoid:**
- Stamp each snapshot field with `updatedAt` timestamps. The reconciliation poll only overwrites a field if its data is newer than the field's current `updatedAt`.
- Use a "dirty flag" approach: when an event updates a field, mark it as "recently updated." The reconciliation poll skips fields that were updated within the last N seconds (e.g., 30s).
- Never let the reconciliation poll run synchronously with event application. Use a mutex or queue that serializes writes to the snapshot store.
- Log when the reconciliation poll detects drift from the event-driven state -- this is the whole point of having a reconciliation poll, and the drift metrics inform whether event delivery is reliable.

**Warning signs:**
- UI values flicker (briefly show old state then snap back to current state).
- Reconciliation poll logs show frequent "correcting drift" messages for the same fields.
- CPU usage spikes at the reconciliation interval (doing expensive work redundantly).

**Phase to address:**
Phase 2 (Event Wiring + Reconciliation). The reconciliation poll design must account for event timing from the start. The field-level timestamp approach should be baked into the snapshot store schema in Phase 1.

---

### Pitfall 6: Git Stat Operations Block the Event Loop

**What goes wrong:**
The current `getProjectSummaryState()` method runs `gitOpsService.getWorkspaceGitStats()` for every workspace in parallel (limited to 3 concurrent). Each git stat operation spawns a child process (`git diff --stat`). With 20 active workspaces, the reconciliation poll spawns 20 git processes in batches of 3, which takes 2-5 seconds total. If this runs in the snapshot service's reconciliation loop, it blocks the event processing pipeline, causing event-driven updates to queue up and arrive in bursts.

**Why it happens:**
Git operations are inherently expensive (child process spawn + filesystem reads). The existing code uses `pLimit(3)` to rate-limit, but the aggregate time is still significant. Moving this work into a snapshot service that also processes real-time events creates contention between the "fast path" (events) and the "slow path" (git stats).

**How to avoid:**
- Separate git stat collection into its own timer/worker that writes results to the snapshot store asynchronously. Never run git operations in the event processing path.
- Use a longer cadence for git stat updates (30-60s) than for other reconciliation (PR status, session state).
- Cache git stats aggressively. Git changes only happen when a session is actively working or the user is in a terminal. Use the session activity state to skip git stat collection for idle workspaces.
- Consider using `fs.watch` on the workspace `.git` directory to trigger git stat refreshes on change, rather than polling.

**Warning signs:**
- Event processing latency spikes at regular intervals (matching the reconciliation cadence).
- Git stat values update in bursts rather than smoothly.
- Server CPU spikes at reconciliation intervals.

**Phase to address:**
Phase 2 (Reconciliation Design). Git stats should be a separate data pipeline feeding into the snapshot store, not part of the main reconciliation loop.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single monolithic snapshot object per workspace | Simple to reason about, one Map entry | As fields grow, every update serializes and sends the entire object over WebSocket. 20 workspaces x full snapshot = bandwidth waste | Never for production. Use field-level deltas from day one. |
| Relying on `JSON.parse(JSON.stringify())` for deep cloning snapshots | Quick immutability guarantee | Silently drops `Date` objects, `undefined` values, and class instances. Causes subtle serialization bugs. | Never. Use structured clone or explicit field copying. |
| Emitting events from domain services directly to the snapshot store | Fast to implement, skip bridge layer | Couples domains to snapshot service. Violates `no-cross-domain-imports`. Forces snapshot service changes when domain internals change. | Never in this codebase. The bridge pattern exists for exactly this reason. |
| Sharing WebSocket connection between chat and snapshot push | One fewer WebSocket connection to manage | Chat messages and snapshot deltas compete for bandwidth. A burst of Claude output can delay snapshot updates. Connection lifecycle is tied to session selection. | Only acceptable if message priority/multiplexing is implemented. Separate channels are safer. |
| Removing polling before WebSocket push is proven reliable | Cleaner code, fewer API calls | Silent data staleness when WebSocket fails. No fallback. Users see frozen UI. | Never in the initial release. Remove polling only after 2+ weeks of WebSocket push working without incidents. |

## Integration Gotchas

Common mistakes when connecting to the existing system.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Bridge wiring in `domain-bridges.orchestrator.ts` | Adding snapshot service wiring inline with existing bridges, creating a 300+ line file | Create a separate `snapshot-bridges.orchestrator.ts` that follows the same pattern. Import in `server.ts` alongside existing bridge configuration. |
| Existing `chatConnectionService` for WebSocket push | Reusing chat connection service for snapshot broadcasts (it forwards by session ID, not workspace ID) | Create a dedicated snapshot connection service or add workspace-level broadcast to an existing service. Chat connections are scoped to sessions; snapshots are scoped to projects. |
| `workspaceActivityService.on('workspace_idle')` | Subscribing directly from snapshot service (cross-domain import) | Wire through orchestration layer: activity service emits event -> bridge forwards to snapshot service -> snapshot updates store |
| `prSnapshotService.applySnapshot()` | Calling snapshot store update directly after PR write (tight coupling to write path) | Use the existing bridge pattern: PR snapshot service calls `kanban.updateCachedKanbanColumn()` through its bridge. Similarly, add a bridge callback for project snapshot notification. |
| Scheduler service PR sync | Running snapshot reconciliation in the same scheduler service | Create a dedicated reconciliation timer. The scheduler already has a single responsibility (PR sync). Adding snapshot reconciliation creates a second concern and makes shutdown coordination harder. |
| Client-side React Query cache | Snapshot WebSocket updates conflict with React Query's `refetchInterval` cache | Use React Query's `queryClient.setQueryData()` to inject WebSocket-received data directly into the cache, replacing the polling-driven updates. Do not have both polling and WebSocket updating the same query key simultaneously. |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Broadcasting full project snapshot to all clients on any workspace change | Works fine with 5 workspaces | Send per-workspace deltas, not full project snapshots. Client merges deltas into local state. | >15 workspaces per project, or >3 concurrent clients |
| Running `git diff --stat` for all workspaces on every reconciliation | Acceptable at 5 workspaces with 3 concurrency | Only run git stats for workspaces with active sessions or recent terminal activity. Cache results for idle workspaces. | >10 workspaces, or workspaces with large repos (>1GB) |
| Serializing entire snapshot Map to JSON on every WebSocket push | Invisible at small scale | Compute JSON delta from previous sent state. Only serialize changed fields. | >20 workspaces, each with multiple field updates per second |
| Synchronous event handlers blocking the snapshot update path | Events process fast when there is one source | Use `setImmediate()` or microtask queue to batch rapid-fire events. Coalesce multiple updates to the same workspace within a tick. | Session working on a workspace with ratchet auto-fix enabled (generates rapid event bursts: session start -> PR push -> CI update -> review comment -> fixer dispatch) |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Broadcasting snapshot data to all WebSocket clients regardless of project access | Client A viewing project 1 receives snapshot updates for project 2 workspaces | Scope WebSocket subscriptions to project ID. Only send workspace snapshot data for workspaces within the client's subscribed project. |
| Including sensitive git diff content in snapshot pushes | Terminal output or file contents leak to unintended UI consumers | Snapshot should contain aggregate stats (lines changed, files changed) never diff content. Git diff content stays in the workspace detail view only. |
| Exposing internal session IDs or process state in snapshot events | Information leakage about system internals | Map internal states to user-facing enum values before including in snapshot. Never expose raw process PIDs or internal error stack traces. |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Optimistic snapshot updates that get reverted by reconciliation poll | User sees workspace move to DONE, then snap back to WAITING, then back to DONE. Trust in the UI erodes. | Never show optimistic state for derived fields (kanban column, CI status). Only show confirmed state from the snapshot store. |
| Removing loading states when switching to event-driven updates | Sidebar appears instant but shows stale data for the first 100ms before the first event arrives | On initial page load or project switch, show a brief skeleton/shimmer until the first full snapshot is received via WebSocket. |
| Replacing all polling simultaneously | One bug in the snapshot service breaks sidebar, Kanban, AND workspace list simultaneously | Migrate one consumer at a time. Start with sidebar (highest frequency, simplest data). Then Kanban. Then workspace list. Keep polling as fallback for unmigrated consumers. |
| Snapshot updates arriving faster than React can render | UI janks as rapid-fire state changes trigger cascading re-renders | Throttle snapshot-to-React-state updates to 200ms intervals. Batch multiple rapid updates into a single render. |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Snapshot Store:** Often missing workspace cleanup on archive -- verify `archiveWorkspace()` calls snapshot store cleanup
- [ ] **Snapshot Store:** Often missing cleanup on server restart -- verify store is empty on startup and rebuilds from DB, not from stale in-memory state
- [ ] **Event Wiring:** Often missing error events -- verify that domain errors (failed PR fetch, crashed session) also trigger snapshot updates, not just success paths
- [ ] **WebSocket Push:** Often missing reconnection protocol -- verify client requests full snapshot on reconnect, not just resubscribes to delta stream
- [ ] **WebSocket Push:** Often missing multi-tab handling -- verify two browser tabs viewing the same project both receive updates correctly
- [ ] **Reconciliation Poll:** Often missing drift logging -- verify the poll logs when it corrects event-driven state, as this metric indicates event reliability
- [ ] **Reconciliation Poll:** Often missing shutdown coordination -- verify `schedulerService.stop()` pattern is replicated: wait for in-flight reconciliation before shutting down
- [ ] **Client Migration:** Often missing stale polling removal -- verify old `refetchInterval` queries are removed after WebSocket consumer is proven working, not left running in parallel indefinitely
- [ ] **Bridge Wiring:** Often missing from test setup -- verify integration tests mock/wire the snapshot bridges, not just unit tests of the store itself
- [ ] **Type Safety:** Often missing Zod validation on WebSocket snapshot messages -- verify incoming snapshot events are validated on the client before applying to React state

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Memory leak in snapshot store | LOW | Deploy fix to add cleanup. Memory recovers on next server restart. No data loss since snapshots are derived. |
| Event ordering race causes stale data | LOW | Reconciliation poll will self-correct within 60 seconds. Fix the race for future events. No permanent data corruption since snapshot is derived from authoritative DB. |
| Domain boundary violation (cross-domain imports) | MEDIUM | Refactor to use bridge pattern. May require changes in multiple files. Run dependency-cruiser to find all violations. |
| WebSocket reconnection drops events | LOW | Clients can refresh page as immediate workaround. Fix reconnection protocol. Reconciliation poll acts as safety net within 60 seconds. |
| Reconciliation poll fights event updates (flickering) | MEDIUM | Add field-level timestamps immediately. May require snapshot store schema change. If timestamps were not included from Phase 1, this is a refactor. |
| Git stat operations block event loop | MEDIUM | Move git stats to separate worker timer. Requires refactoring the reconciliation pipeline. Data is not lost, just delayed. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Memory leak on workspace lifecycle | Phase 1: Core Store | Test: create snapshot -> archive workspace -> assert snapshot cleared. Monitor: snapshot store size < active workspace count + 10% buffer. |
| Event ordering races | Phase 1: Core Store | Store schema includes field-level `updatedAt` timestamps. Write path has compare-and-swap or version check. Test: concurrent writes to same workspace do not regress state. |
| Breaking domain boundaries | Phase 1: Architecture | dependency-cruiser passes with no new violations. Snapshot service has zero imports from `@/backend/domains/`. All domain data arrives via bridge interfaces. |
| WebSocket reconnection drops | Phase 3: WebSocket Integration | Test: disconnect WebSocket -> emit events -> reconnect -> verify client receives full snapshot. Manual test: close laptop lid for 30s -> open -> verify UI is current. |
| Reconciliation/event oscillation | Phase 2: Event Wiring | Reconciliation poll logs drift corrections. Drift corrections trend toward zero over time. No UI flickering observed in manual testing. |
| Git stat blocking event loop | Phase 2: Reconciliation | Git stats run on separate timer. Event processing latency does not spike at reconciliation intervals. Profiling shows no event queue buildup during git stat collection. |
| Removing polling too early | Phase 4+: Client Migration | Polling remains as fallback during Phase 3. Only removed per-consumer after 2+ weeks of successful WebSocket-only operation in development. |
| Client-side render janking | Phase 3: Client Integration | Throttle WebSocket-to-state updates. Measure render time with React DevTools. No dropped frames during rapid event bursts. |

## Sources

- Codebase analysis: `src/backend/domains/workspace/lifecycle/activity.service.ts` (existing in-memory Map pattern with cleanup gap)
- Codebase analysis: `src/backend/orchestration/domain-bridges.orchestrator.ts` (bridge wiring pattern to follow)
- Codebase analysis: `src/backend/services/scheduler.service.ts` (existing reconciliation loop pattern)
- Codebase analysis: `src/backend/domains/workspace/query/workspace-query.service.ts` (current polling-based state aggregation)
- Codebase analysis: `src/backend/domains/session/chat/chat-connection.service.ts` (existing WebSocket forwarding pattern)
- Codebase analysis: `src/backend/domains/github/pr-snapshot.service.ts` (existing snapshot-and-bridge pattern)
- [Materialized View pattern - Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)
- [Event Driven Architecture - 5 Pitfalls to Avoid (Wix Engineering)](https://medium.com/wix-engineering/event-driven-architecture-5-pitfalls-to-avoid-b3ebf885bdb1)
- [WebSocket Reconnect: Strategies for Reliable Communication](https://apidog.com/blog/websocket-reconnect/)
- [How to Implement Reconnection Logic for WebSockets](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view)
- [Common Memory Leak Patterns in Node.js](https://medium.com/@hemangibavasiya08/common-memory-leak-patterns-in-node-js-and-how-to-avoid-them-41c8944af604)
- [Testing Event-Driven Systems (Confluent)](https://www.confluent.io/blog/testing-event-driven-systems/)
- [Event Driven Architecture Done Right: How to Scale Systems with Quality in 2025](https://www.growin.com/blog/event-driven-architecture-scale-systems-2025/)
- [Mattermost WebSocket reconnection issue #30388](https://github.com/mattermost/mattermost/issues/30388) (real-world missed-event bug)

---
*Pitfalls research for: In-memory project snapshot service with event-driven deltas*
*Researched: 2026-02-11*
