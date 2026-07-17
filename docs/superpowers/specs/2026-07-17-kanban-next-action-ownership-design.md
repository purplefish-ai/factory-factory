# Kanban Next-Action Ownership Design

## Goal

Make Kanban columns describe who owns the next action instead of whether an agent process is executing at this instant. A workspace remains in `WORKING` while setup, CI, or Ratchet automation owns forward progress and moves to `WAITING` only when a human action is required or automatic Ratchet retries are exhausted.

Live agent activity remains a separate `isWorking` signal. The change does not make CI polling or Ratchet monitoring look like a running agent session.

## Root Cause

The workspace flow derivation already classifies `CI_WAIT`, `RATCHET_VERIFY`, and `RATCHET_FIXING` as active workflow phases. The Kanban derivation discards that information and passes only live session activity to `computeKanbanColumn`. Once an agent session becomes idle, every ready nonterminal workspace therefore falls through to `WAITING`.

PR snapshot events reach the workspace snapshot store immediately. A CI-status update only triggers an immediate Ratchet check when it also represents a pull-request identity change; ordinary CI transitions wait for the Ratchet polling loop. This makes the semantic mismatch visible as a `WORKING -> WAITING -> WORKING` jump between CI completion and fixer dispatch.

Commit `981985cd` intentionally removed flow activity from the Kanban working signal to prevent stale persisted PR state from masquerading as a live agent after process restart. Restoring the old combined `isWorking` value would reintroduce that conflation. The solution must keep live execution and workflow ownership distinct.

## Considered Approaches

### Derive Kanban from next-action ownership

Keep `isWorking` session-only and give the Kanban derivation the flow state plus explicit human-attention inputs. This is the selected approach because it matches the product meaning directly, preserves accurate live-session indicators, and can represent exhausted Ratchet retries without pretending a session is active.

### Recombine session and flow activity into `isWorking`

Using `sessionIsWorking || flowState.isWorking` would remove the common CI/Ratchet flicker. It would also label CI polling as agent execution, obscure the distinction fixed by `981985cd`, and leave exhausted Ratchet retries in `WORKING` because the flow phase remains `RATCHET_FIXING`.

### Wake Ratchet on every CI snapshot update

An immediate check would reduce the delay before fixer dispatch but would not correct the column model. Ready-for-review work, setup failures, inactive workspaces, and exhausted retries would still be classified through session activity rather than ownership. It also adds GitHub fetching pressure without being necessary for the semantic fix.

## Column Rules

The derivation uses the following precedence:

1. `ARCHIVING` and `ARCHIVED` return `null`, preserving the existing pre-archive cached column behavior.
2. A merged or closed pull request, or Ratchet `MERGED`, returns `DONE`.
3. Explicit human-attention states return `WAITING`:
   - workspace lifecycle `FAILED`;
   - a pending permission request, plan approval, or user question;
   - a session runtime error;
   - Ratchet dispatch outcome `DIED` with `ratchetDispatchRetryCount` at or above `SERVICE_THRESHOLDS.ratchetDispatchMaxRetries`.
4. Automation-owned states return `WORKING`:
   - lifecycle `NEW` or `PROVISIONING`;
   - a live agent session;
   - flow state `CI_WAIT`, `RATCHET_VERIFY`, or `RATCHET_FIXING` while no higher-priority human-attention rule applies.
5. Every remaining nonterminal workspace returns `WAITING`. This includes no session started, ready for another prompt, ready for review or merge, and terminal CI with Ratchet disabled.

A `COMPLETED` Ratchet dispatch does not by itself require human attention. A fixer commonly exits cleanly after pushing while Ratchet continues monitoring for the next PR/CI snapshot. Existing same-snapshot dispatch suppression remains unchanged.

Run-script status does not determine Kanban ownership. A running development server can coexist with either a human-owned or automation-owned next step.

## Architecture

### Canonical derivation

`assembleWorkspaceDerivedState` remains the canonical composition point. It will continue returning session-only `isWorking`, but it will pass these independent inputs to the Kanban derivation:

- lifecycle and terminal PR/Ratchet state;
- `sessionIsWorking`;
- `flowState.isWorking` or its phase-equivalent automation-ownership signal;
- pending interactive request and session runtime error;
- Ratchet dispatch outcome and retry count.

`computeKanbanColumn` remains a pure function. The exact input names may be chosen to make the distinction between session activity, workflow activity, and human attention explicit; it must not accept a single ambiguous combined `isWorking` boolean.

The status-reason derivation continues to produce user-facing labels. Kanban must not infer ownership solely from `WorkspaceStatusReason.needsUser`, because ready-for-review and ready-to-merge are human-owned but currently use informational reasons with `needsUser: false`.

### Snapshot propagation

`WorkspaceSnapshotEntry` and `SnapshotUpdateInput` will carry `ratchetDispatchOutcome` and `ratchetDispatchRetryCount` in the Ratchet field group. Reconciliation seeds both fields from the workspace row so startup classification is deterministic.

Ratchet dispatch mutations that can change ownership will publish the updated outcome and retry count through the existing event-collector boundary. In particular, settling a fixer as `DIED` must update the snapshot immediately; the board must not wait for periodic reconciliation to learn that retries are exhausted. Dispatching a retry should likewise publish the new `RUNNING` outcome and retry count so the snapshot remains authoritative.

No Prisma migration is required because both fields already exist on `Workspace`.

### Cached column

The persisted `cachedKanbanColumn` must use the same ownership rules for durable workspace state while treating session activity as false. PR snapshot, Ratchet state, dispatch-outcome, and lifecycle update paths must refresh the cache when their changes can alter ownership.

This cache is not evidence of a live agent. On process restart, flow state is recomputed from the persisted PR and Ratchet fields, while live session activity starts from the reconciled runtime state. An enabled Ratchet with an active PR legitimately remains automation-owned until Ratchet reaches `READY`/`MERGED` or the explicit exhausted-retry rule requires human attention.

## Data Flow

For a failing CI run with Ratchet enabled:

1. While checks are pending, flow phase is `CI_WAIT`; Kanban is `WORKING` even if the authoring session has ended.
2. A failed CI snapshot is applied. Until Ratchet evaluates it, flow phase is `RATCHET_VERIFY`; Kanban remains `WORKING`.
3. Ratchet determines `CI_FAILED` and dispatches a fixer. Flow phase is `RATCHET_FIXING`; the live session signal becomes true once the fixer works, but the column does not change.
4. If the fixer dies below the retry limit, Ratchet still owns the next retry and the column remains `WORKING`.
5. If a fixer dies at the retry limit, the exhausted-dispatch override moves the workspace to `WAITING` immediately.
6. A later PR-state change resets dispatch eligibility through the existing Ratchet snapshot logic; normal automation ownership resumes when appropriate.

For successful CI, Ratchet transitions to `READY`; flow activity becomes false and the workspace moves to `WAITING` for human review or merge.

## Testing

Tests will be added before production changes and observed failing for the current session-only derivation.

1. Pure Kanban tests cover every precedence rule: archived, terminal PR, failed lifecycle, pending interaction, session runtime error, setup, live session, each active flow phase, idle ready state, and exhausted Ratchet retries.
2. Derived-state tests prove `isWorking` remains false during CI/Ratchet flow activity while `kanbanColumn` is `WORKING`.
3. Snapshot-store tests exercise `CI_WAIT -> RATCHET_VERIFY -> RATCHET_FIXING -> exhausted DIED` and verify the column sequence contains no transient `WAITING` before exhaustion.
4. Event-collector tests prove dispatch outcome/retry events update the snapshot immediately.
5. Cached-column and lifecycle tests prove `FAILED` is `WAITING`, setup is `WORKING`, active persisted flow is `WORKING`, Ratchet `READY` is `WAITING`, and exhausted retries are `WAITING`.
6. Existing status-reason, sidebar, Ratchet deduplication, and bounded-retry tests remain unchanged unless their fixtures need the two newly propagated raw fields.

Verification will run focused state, snapshot, event-collector, lifecycle, and Ratchet tests, followed by `pnpm typecheck`, `pnpm check`, the full Vitest suite, and `pnpm build`. Formatting changes will use `pnpm check:fix` only after the behavior is green.

## Non-goals

- Changing Ratchet poll frequency or GitHub fetch deduplication.
- Changing Ratchet dispatch, completion, retry, or snapshot-key semantics.
- Treating a clean `COMPLETED` fixer as human-required without another explicit signal.
- Adding a new Kanban column or changing column labels.
- Treating a running development server as automation ownership.
- Persisting live agent activity as durable workflow state.
