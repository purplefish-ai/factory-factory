# Design Doc: Persistent Insights in Auto-Iteration Mode

**Status:** Finalized draft
**Date:** 2026-04-03

---

## Problem Statement

Auto-iteration mode runs an agent in a closed loop to improve a codebase against a target metric. Over many iterations the agent accumulates valuable knowledge — deferred approaches that were too risky to try mid-run, hypotheses about what might unlock larger gains, environmental observations (e.g. "the test suite is non-deterministic under condition X") — but has no first-class place to record it prospectively.

The **logbook** (`auto-iteration-logbook.json`) is a retrospective record of what was *attempted* (accepted, rejected, crashed). It is useful for session recycles within a run, but:

- It is **overwritten when a new run starts**, so nothing carries forward
- It records outcomes, not forward-looking ideas
- Humans cannot easily contribute to it

As a result, every new run starts blind. The agent repeats dead ends it already discovered, and humans have no channel to seed ideas into the loop.

---

## Goals

- Give the agent a place to record **prospective insights** during a run: deferred approaches, hypotheses, environmental observations — anything that might help attain the target
- Make those insights **accessible to the same workspace's subsequent runs**
- Allow **humans to read and contribute** insights (bidirectional)
- Keep the mechanism **lightweight** — a plain Markdown file the agent writes to directly
- Allow insights to be **marked resolved or obsolete** so stale content does not accumulate

### Non-Goals (v1)

- Cross-workspace insight sharing
- Structured querying or search over insights
- Insights persisting through workspace archival

---

## Solution: `.factory-factory/auto-iteration-insights.md`

Introduce a single Markdown file that persists across runs within a workspace. The agent may freely read and write it during any phase. Humans may edit it via a text editor in the UI.

### File location

```
{worktreePath}/.factory-factory/auto-iteration-insights.md
```

Same directory as the logbook. Excluded from git commits (via `unstageInsights()` in `git-ops.ts`, mirroring how the logbook is handled).

### Format convention

Freeform Markdown. The agent and humans write naturally. A light tagging convention is used to signal insight status:

```markdown
# Auto-Iteration Insights

## Run #4 — 2026-04-03

- Splitting `parseModule` into parse + validate phases could remove the double-traversal
  causing ~40% of the latency. Worth a dedicated run targeting that refactor. `[open]`

- Inlining the hot path in `compiler.ts` was rejected by critique as too complex.
  Before retrying, improve the surrounding abstractions first. `[open]`

- Tests are flaky when `PARALLEL_WORKERS > 4` due to shared global state in `registry.ts`.
  Consider fixing this before running again with high parallelism. `[open]`

## Run #2 — 2026-03-28

- The JVM rewarms each test run, inflating latency measurements. A persistent test daemon
  would give more stable signals. `[resolved — persistent daemon added in run #3]`

- Tried memoizing `resolveImports` — not profitable, cache overhead exceeded savings. `[obsolete]`
```

**Status tags:**
- `[open]` — active, inject into future runs
- `[resolved]` — addressed; keep for history but exclude from injection
- `[obsolete]` — no longer relevant; agent or human may delete or keep for reference

Untagged entries are treated as `[open]` by default.

---

## How Insights Are Written

### By the agent

The agent is instructed in its **system prompt** that it may write to the insights file at any time:

```
You have access to a persistent insights file at .factory-factory/auto-iteration-insights.md.
Use it to record ideas, hypotheses, deferred approaches, or environmental observations that
might help attain the target in future runs. Write to it whenever you notice something worth
preserving — you do not need to wait for a specific phase. You may also mark old entries as
[resolved] or [obsolete], and trim the file to remove clutter when appropriate.
```

The agent writes using its normal file tools — no special structured output format required. It can append a new run section, add bullet points, update tags, or prune stale entries as it sees fit.

### By humans

The auto-iteration panel in the UI exposes a **text editor tab** showing the raw Markdown of the insights file. Humans can:

- Add ideas before starting a run ("try approach X")
- Mark entries resolved after reviewing results
- Delete or rewrite entries freely

Changes are saved directly to the file in the worktree.

---

## How Insights Are Consumed

### On run start (system prompt)

When a new auto-iteration run begins, the full contents of the insights file (filtered to `[open]` entries, capped at a token budget — suggested ~2000 tokens) are injected into the **system prompt**:

```
INSIGHTS FROM PREVIOUS RUNS (from auto-iteration-insights.md):
{filtered contents}

Use these as starting points. They are not exhaustive — explore freely, but do not repeat
approaches already recorded as obsolete.
```

If the file does not exist or contains no `[open]` entries, this section is omitted.

### On session recycle (handoff prompt)

The same filtered insights are included in the **session recycle handoff prompt**, alongside the logbook summary. This ensures knowledge is carried forward even within long runs that cross session boundaries.

---

## Insight Lifecycle

```
[open]  ──→  [resolved]   (entry addressed; exclude from injection, keep for history)
        ──→  [obsolete]   (entry no longer relevant; may be deleted)
        ──→  (deleted)    (agent trims the file; entry gone)
```

The agent is encouraged to trim the file periodically — e.g., during session recycles — to keep the injection footprint manageable. There is no enforced size limit; the agent exercises judgment.

---

## Implementation Plan

### 1. File service (`insights.service.ts`)

Add alongside `logbook.service.ts` in `src/backend/services/auto-iteration/service/`:

```typescript
export const insightsService = {
  read(worktreePath: string): Promise<string | null>;
  write(worktreePath: string, content: string): Promise<void>;  // used by UI save endpoint
  initialize(worktreePath: string): Promise<void>;  // create file if absent
  getOpenContent(worktreePath: string): Promise<string | null>;  // filter to [open], cap chars
};
```

The `write` method is used by the tRPC `saveInsights` endpoint (UI editor tab). The agent also writes directly via file tools.

### 2. Git exclusion (`git-ops.ts`)

Add `unstageInsights()` mirroring `unstageLogbook()`. Call it in `commitAll()` before every commit.

### 3. System prompt (`prompts.ts`)

Update `buildSystemPrompt()` to accept optional `insightsContent: string | null` and inject the insights block.

### 4. Handoff prompt (`prompts.ts`)

Update `buildHandoffPrompt()` similarly.

### 5. Run start (`auto-iteration.service.ts`)

On `start()`, call `insightsService.initialize()` (no-op if file exists), read open entries, pass to prompt builders.

### 6. UI: insights editor tab

In `auto-iteration-panel.tsx`, add a tab alongside the logbook viewer that renders the raw Markdown in an editable textarea, with a save button that writes to the file via a new tRPC endpoint:

```typescript
// auto-iteration.trpc.ts
getInsights(workspaceId): string | null
saveInsights(workspaceId, content: string): void
```

---

## What This Doesn't Solve

- **Bidirectional agent ↔ agent across workspaces** — insights are workspace-scoped. A separate "workspace notes" or project-level knowledge base would be needed for that.
- **Structured querying** — the file is freeform. If insight volume grows large enough to need search, a future v2 could introduce structured JSON with a Markdown view layer.
- **Automatic insight generation** — the agent writes insights opportunistically. A future "reflection phase" (a dedicated prompt every N iterations) could actively synthesize insights rather than relying on the agent noticing something worth recording.
