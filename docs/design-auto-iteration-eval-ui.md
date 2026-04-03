# Design Doc: Auto-Iteration Eval Visibility UI Improvements

## Problem Statement

Three related issues make the auto-iteration UI opaque during the measure/evaluate phase:

### Issue 1 — Live test output is not actually live (bug)

The panel has a `LiveTestOutput` section intended to stream stdout/stderr from the test command. It doesn't work because:

- `runTestCommand` buffers all output locally and resolves only when the process exits — no incremental updates
- During the `measuring` phase, `lastTestOutput` in the progress object is **not updated** — it still holds the value from the previous phase transition. The current test's output is only written to `lastTestOutput` *after* the test completes, when the phase transitions to `evaluating`
- So during the entire test run window (`measuring` phase, which can last 10s–5min), the panel shows either nothing or stale output from a prior iteration

Relevant code:
- `auto-iteration.service.ts:540` — `emitPhase(loop, 'measuring')` called with no output arg → `lastTestOutput` unchanged
- `test-runner.service.ts:14–69` — `runTestCommand` returns a Promise; no streaming callback
- `auto-iteration.service.ts:596` — `emitPhase(loop, 'evaluating', postOutput)` only called after test completes

### Issue 2 — Eval phase is invisible in the stepper

The 3-stage banner stepper maps:

| Backend Phase | UI Stage |
|---|---|
| `implementing` | Improve |
| `measuring` | **Measure** |
| `evaluating` | **Measure** ← same stage |
| `critiquing` | Critique |

Both `measuring` (running the test command) and `evaluating` (LLM deciding `improved`/`targetReached`) collapse into one "Measure" step. Users cannot tell which sub-step is active.

### Issue 3 — No indication of eval LLM result

When the LLM evaluation finishes (`evaluating` → `critiquing`/`idle`), there's no moment where the panel surfaces the decision (`improved: true/false`, `metricSummary`). The result only appears post-hoc in the logbook entry.

---

## Proposed Design

### Fix 1 — Stream test output incrementally

**Approach:** Use an in-memory accumulator on the running loop rather than DB writes per-chunk.

1. Add `currentTestOutputBuffer: string` to the `RunningLoop` in-memory object
2. Modify `runTestCommand` to accept an optional `onChunk: (chunk: string) => void` callback
3. In `runIteration`, pass a callback that appends to `loop.currentTestOutputBuffer` as stdout/stderr chunks arrive
4. Modify `getStatus()` to return `currentTestOutputBuffer` as `lastTestOutput` when phase is `measuring`
5. When `emitPhase('evaluating', postOutput)` is called, the final truncated output replaces it

This keeps DB writes unchanged (still one write per phase transition) while making in-memory state reflect live output. Since the panel polls `getStatus` every 3s and `getStatus` reads from in-memory state when running, live chunks will appear within 3s of being emitted.

**Impact:** No DB schema changes, no new endpoints. Minimal change surface.

### Fix 2 — Sub-indicator inside "Measure" step

In both the progress banner and the panel's phase indicator, distinguish between the two sub-states within the "Measure" stage:

| `currentPhase` | Sub-indicator label |
|---|---|
| `measuring` | Running tests... |
| `evaluating` | Evaluating with LLM... |

**Banner:** Keep 3 steps (Improve → Measure → Critique). Inside the active "Measure" step, render a small secondary label showing the current sub-state.

**Panel PhaseIndicator:** Same label distinction.

### Fix 3 — Show eval result briefly after eval completes

After the `evaluating` phase ends, surface the LLM's decision before the panel moves on:

- During `evaluating`: show test output + "Evaluating with LLM..." spinner overlay at bottom of output pane
- When eval completes and phase transitions: flash the result in the phase indicator area (e.g. "Improved ✓" or "Regressed — reverting") for the duration of the `critiquing` or revert phase

**Implementation options:**
- Option A (simplest): Store `lastEvalDecision: { improved: boolean; metricSummary: string } | null` in `AutoIterationProgress`, set it during `evaluating` phase, clear it at end of iteration
- Option B: Derive from `currentMetricSummary` change — but this only updates on accepted iterations, so it misses regressions

Recommend Option A.

---

## Files Affected

| File | Change |
|---|---|
| `test-runner.service.ts` | Add `onChunk` callback param to `runTestCommand` |
| `auto-iteration.types.ts` | Add `currentTestOutputBuffer` to `RunningLoop`; add `lastEvalDecision` to `AutoIterationProgress` |
| `auto-iteration.service.ts` | Wire `onChunk` in `runIteration`; set `lastEvalDecision` in evaluate phase; clear on iteration end |
| `auto-iteration.trpc.ts` | Return `currentTestOutputBuffer` as `lastTestOutput` override when phase is `measuring` |
| `auto-iteration-progress-banner.tsx` | Add sub-label inside Measure step |
| `auto-iteration-panel.tsx` | Update `PhaseIndicator` sub-labels; add eval result display |

---

## Out of Scope

- Streaming LLM eval tokens (adds significant complexity; Option A decision display is sufficient)
- Persisting eval logs to logbook (only show live)
- Changes to the compact banner beyond sub-indicator label
