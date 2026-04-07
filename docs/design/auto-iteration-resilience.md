# Auto-Iteration Resilience and Recovery — Design Document

## Problem Statement

The auto-iteration system runs a long-lived in-memory loop (`AutoIterationService.runLoop`) that iterates on code improvements across five phases: IMPLEMENT, MEASURE, CRASH HANDLING, EVALUATE, CRITIQUE. Phase transitions are synchronous — `sendAcpMessage()` blocks until the agent's ACP turn completes via `handle.connection.prompt()`.

This loop has **no resilience mechanisms**. Any failure — a hung agent, a server restart, or an unexpected session termination — leaves the workspace permanently stuck in `RUNNING` status with no recovery path short of manual database intervention.

### P1: Indefinite prompt hang

`handle.connection.prompt()` (`acp-runtime-manager.ts:1068`) blocks until the agent completes its turn. If the agent process is alive but unresponsive, this promise never resolves or rejects. The auto-iteration loop freezes completely.

The `waitForIdle()` bridge method is a no-op because `sendAcpMessage` already blocks:

```typescript
// domain-bridges.orchestrator.ts:275-277
async waitForIdle(_sessionId) {
  // sendAcpMessage already blocks until the turn completes
}
```

There is no timeout, heartbeat, or watchdog at the ACP prompt level.

### P2: No server startup recovery

The loop state lives entirely in memory (the `this.loops` Map in `AutoIterationService`). The database field `autoIterationStatus` is set to `RUNNING`, but on server restart nothing detects or resets these stale records. The workspace appears running forever with no active loop behind it.

By contrast, run-scripts have `recoverStaleStates()` called at startup (`server.ts:336`) that resets transient `STARTING`/`STOPPING` states to `IDLE`.

### P3: No periodic health check

The codebase uses periodic checks for other features:
- **Ratchet**: 2-minute polling loop (`SERVICE_INTERVAL_MS.ratchetPoll`)
- **Scheduler**: 3-minute PR sync interval (`SERVICE_INTERVAL_MS.schedulerPrSync`)
- **Reconciliation**: 5-minute orphan cleanup (`SERVICE_INTERVAL_MS.reconciliationCleanup`)

Auto-iteration has no equivalent watchdog. A stuck loop persists indefinitely at runtime with no external detection.

### P4: Session death not surfaced to auto-iteration

When an ACP child process exits, `wireChildExitHandler` (`acp-runtime-manager.ts:861`) fires, which calls `onExit` in the session lifecycle service (`session.lifecycle.service.ts:409`). This marks the session as `COMPLETED` and deletes it from the runtime map.

However, the auto-iteration service is **not notified**. The blocked `sendPrompt` call may reject via stream error when the child dies, and the `runLoop` catch handler sets status to `FAILED` — but this relies on the stream error propagating correctly through the ACP SDK, which is not guaranteed for all death modes (SIGKILL, OOM killer, etc.).

---

## Solutions Considered

### A: Prompt-Level Timeout

Add an optional `timeoutMs` parameter to `AcpRuntimeManager.sendPrompt()`. Wrap `handle.connection.prompt()` in `Promise.race` with a timer. On timeout, attempt `cancelPrompt` to signal the agent, then SIGTERM the child process after a grace period.

| | |
|---|---|
| **Addresses** | P1 |
| **Pros** | Fixes the root cause; benefits all callers of `sendPrompt`, not just auto-iteration; the `withTimeout` pattern already exists in the codebase (used during ACP initialization at `acp-runtime-manager.ts:777-793`) |
| **Cons** | Choosing a good default is hard — agent turns can legitimately take 10-30 minutes for complex code changes; could interrupt valid work in interactive sessions |
| **Complexity** | Medium |
| **Key design decision** | Timeout is **per-caller, not global**. Auto-iteration passes its own timeout (default 20 min). Interactive sessions use no timeout. |

### B: Server Startup Recovery

On server startup, query the database for workspaces with `autoIterationStatus = 'RUNNING'` and reset them to `FAILED`. Follow the exact pattern of `runScriptStateMachine.recoverStaleStates()` (`run-script-state-machine.service.ts:251-274`).

| | |
|---|---|
| **Addresses** | P2 |
| **Pros** | Simple; follows a well-established pattern; deterministic fix; ~30 lines of new code |
| **Cons** | Only handles server restart, not runtime hangs |
| **Complexity** | Low |

### C: Periodic Watchdog Service

A new service that periodically checks all workspaces with `autoIterationStatus = 'RUNNING'` and verifies the in-memory loop is active and making progress. Uses `lastIterationAt` from the progress JSON to detect staleness. Takes corrective action (kill session, mark failed) if no progress for N minutes.

| | |
|---|---|
| **Addresses** | P3 |
| **Pros** | Comprehensive runtime monitoring; catches hung loops, zombie states, and DB/memory inconsistencies |
| **Cons** | False-positive risk — slow but valid iterations could be flagged; threshold tuning is tricky; overlaps with Solution A |
| **Complexity** | Medium-high |

### D: Session Death Propagation

When the `onExit` handler fires for a session that belongs to an auto-iteration workspace, notify `AutoIterationService` via an event/bridge so it can clean up immediately rather than relying on the promise rejection chain.

| | |
|---|---|
| **Addresses** | P4 |
| **Pros** | Fast detection of process death (seconds, not minutes); clean error propagation path |
| **Cons** | Does not help with hung-but-alive agents (P1); requires bridge wiring to respect service capsule boundaries |
| **Complexity** | Medium |

### E: Heartbeat Tracking

Add `heartbeatAt` and `currentPhase` fields to the in-memory `RunningLoop`, updated before each `sendPrompt` call. Enriches the `getStatus()` API response for observability.

| | |
|---|---|
| **Addresses** | Observability (enables manual diagnosis, enriches UI) |
| **Pros** | Trivial to add; helps surface where the loop is stuck |
| **Cons** | Not a fix on its own — needs a timeout or watchdog to act on staleness |
| **Complexity** | Low |

---

## Recommendation: B + A + D (+ optional E)

### Why not C (Watchdog)?

With B + A + D in place, the coverage is comprehensive:
- **Server restart** → B (startup recovery)
- **Hung agent** → A (prompt timeout)
- **Dead session** → D (death propagation)
- **Between-iteration errors** → existing `runLoop` catch handler

A periodic watchdog becomes a defense-in-depth measure rather than a necessity. The false-positive risk and implementation complexity don't justify it as a first pass. It can be added later if the A + D combination proves insufficient in practice.

---

## Implementation

### Phase 1: Server Startup Recovery (Solution B)

**Low complexity, high impact.** Should be implemented first.

**Files:**
- `src/backend/services/workspace/resources/workspace.accessor.ts` — Add `resetStaleAutoIterationStatuses()` following the pattern at lines 304-321 (`resetStaleRunScriptStatuses`)
- `src/backend/server.ts` — Call `workspaceAccessor.resetStaleAutoIterationStatuses()` directly after existing `runScriptStateMachine.recoverStaleStates()` (~line 336)

Note: Unlike run-script recovery (which goes through `runScriptStateMachine.recoverStaleStates()`), auto-iteration recovery is called directly from `server.ts` via `workspaceAccessor` to avoid a circular dependency (auto-iteration ↔ workspace). The recovery is purely a database operation with no in-memory loop manipulation needed.

Target status on recovery: `FAILED` (not `PAUSED`), because the in-memory loop context is irrecoverably lost on server restart. The user can re-start auto-iteration manually.

```typescript
// workspace.accessor.ts — following resetStaleRunScriptStatuses pattern
async resetStaleAutoIterationStatuses(): Promise<Array<{ id: string }>> {
  const stale = await prisma.workspace.findMany({
    where: { autoIterationStatus: 'RUNNING' },
    select: { id: true },
  });
  if (stale.length === 0) return [];
  await prisma.workspace.updateMany({
    where: { id: { in: stale.map(w => w.id) }, autoIterationStatus: 'RUNNING' },
    data: { autoIterationStatus: 'FAILED', autoIterationSessionId: null },
  });
  return stale;
}
```

### Phase 2: Prompt-Level Timeout (Solution A)

**Medium complexity, high impact.**

**Files:**
- `src/backend/services/session/service/acp/acp-runtime-manager.ts` — Add optional `timeoutMs` to `sendPrompt()` (line 1060), introduce `PromptTimeoutError`
- `src/backend/services/session/service/lifecycle/session.service.ts` — Pass through `timeoutMs` in `sendAcpMessage()` (line 264)
- `src/backend/services/auto-iteration/service/bridges.ts` — Extend `AutoIterationSessionBridge.sendPrompt` to accept optional timeout
- `src/backend/orchestration/domain-bridges.orchestrator.ts` — Pass timeout through bridge implementation (line 272)
- `src/backend/services/auto-iteration/service/auto-iteration.types.ts` — Add `promptTimeoutSeconds` to `AutoIterationConfig`
- `src/backend/services/auto-iteration/service/auto-iteration.service.ts` — Pass timeout on every `sendPrompt` call; catch `PromptTimeoutError` as a crash (revert + continue)

**Key design decisions:**

1. **Per-caller timeout**: Auto-iteration uses 20-minute default; interactive sessions pass no timeout (indefinite). The timeout is an optional parameter — existing callers are unaffected.

2. **Timeout escalation**: On timeout, attempt `cancelPrompt()` first. If that doesn't resolve within 5 seconds, escalate to SIGTERM on the child process (follows existing `stopClient` pattern at `acp-runtime-manager.ts:1012-1049`).

3. **Auto-iteration crash handling**: `PromptTimeoutError` is treated identically to a test crash — revert uncommitted changes, increment `crashedCount`, continue loop.

```typescript
// acp-runtime-manager.ts
export class PromptTimeoutError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(`ACP prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
    this.name = 'PromptTimeoutError';
  }
}

async sendPrompt(
  sessionId: string,
  prompt: ContentBlock[],
  timeoutMs?: number,
): Promise<{ stopReason: string }> {
  const handle = this.sessions.get(sessionId);
  handle.isPromptInFlight = true;
  try {
    const promptPromise = handle.connection.prompt({
      sessionId: handle.providerSessionId,
      prompt,
    });
    if (!timeoutMs) {
      const result = await promptPromise;
      handle.isPromptInFlight = false;
      return { stopReason: result.stopReason };
    }
    const result = await Promise.race([
      promptPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new PromptTimeoutError(sessionId, timeoutMs)), timeoutMs),
      ),
    ]);
    handle.isPromptInFlight = false;
    return { stopReason: result.stopReason };
  } catch (error) {
    handle.isPromptInFlight = false;
    throw error;
  }
}
```

### Phase 3: Session Death Propagation (Solution D)

**Medium complexity, medium impact.**

**Files:**
- `src/backend/services/auto-iteration/service/auto-iteration.service.ts` — Add `onSessionDeath(workspaceId, sessionId)` method (idempotent cleanup)
- `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts` — In `onExit` handler (line 409), call notification bridge for auto-iteration sessions
- `src/backend/orchestration/domain-bridges.orchestrator.ts` — Wire the notification bridge

**Respecting service capsule boundaries:** The session service should not import from auto-iteration. Instead, use an event/bridge pattern:

1. Session lifecycle emits a notification via a bridge when a session with a known workflow exits
2. The orchestration layer wires the bridge to call `autoIterationService.onSessionDeath()`
3. `onSessionDeath` is idempotent — if the loop is already cleaned up by the promise rejection, it's a no-op

```typescript
// auto-iteration.service.ts
onSessionDeath(workspaceId: string, sessionId: string): void {
  const loop = this.loops.get(workspaceId);
  if (!loop || loop.sessionId !== sessionId) return;

  this.logger.warn('Auto-iteration session died unexpectedly', { workspaceId, sessionId });
  loop.stopRequested = true;
  this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
  this.loops.delete(workspaceId);
}
```

### Phase 4 (Optional): Heartbeat Enrichment (Solution E)

**Low complexity, observability improvement.**

Add `heartbeatAt: Date` and `currentPhase: string` to the in-memory `RunningLoop`. Update before each `sendPrompt` call in `runIteration()`. Include in `getStatus()` response so the UI can show "Currently in MEASURE phase, started 5 minutes ago" instead of just "RUNNING".

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Prompt timeout too aggressive for complex turns | Default 20 min; configurable per-workspace via `AutoIterationConfig.promptTimeoutSeconds`; interactive sessions unaffected (no timeout) |
| `cancelPrompt` hangs after timeout | Escalate to SIGTERM/SIGKILL after 5s grace period (follows existing `stopClient` pattern) |
| Startup recovery resets a workspace the user expected to resume | `FAILED` status is visible in UI; clear log message explains recovery; user can re-start manually |
| Session death notification races with promise rejection | `onSessionDeath` is idempotent — no-op if loop is already cleaned up |
| Adding `timeoutMs` to `sendPrompt` changes API surface | Parameter is optional with default `undefined` (no timeout); existing callers are unaffected |

---

## Open Questions / Future Work

- **Watchdog service (Solution C)**: If A + D prove insufficient in practice (e.g., edge cases where the agent hangs AND the session doesn't die), a periodic watchdog can be added as defense-in-depth. The `lastIterationAt` timestamp already exists in progress for staleness detection.
- **Consecutive crash threshold**: Should the loop auto-pause after N consecutive crashes (timeouts or otherwise) rather than continuing to burn iterations? Worth considering as a follow-up.
- **Resume from FAILED**: Currently `FAILED` is terminal. A future improvement could allow resuming from `FAILED` by re-creating the in-memory loop context from persisted progress.
