# Auto-Iteration Workspace — Design Document

## Problem Statement

Factory Factory workspaces currently operate as open-ended sessions: a user describes work, an LLM agent implements it, and the user reviews the result. There is no built-in mechanism for **goal-directed, metric-driven iteration** — where the system repeatedly attempts to improve code against a measurable target.

Users want to define a quantitative goal (e.g., "get test pass rate from 60% to 95%", "reduce bundle size below 200KB", "lower p99 latency to <50ms") and have the system autonomously iterate toward it, keeping good changes and discarding bad ones.

## Solution Overview

Introduce **auto-iteration workspaces** — a new workspace mode where:

1. The user specifies a **test command** (produces measurable output) and a **target** (what "done" looks like).
2. The system runs an autonomous loop: **measure → analyze → implement → measure → evaluate → critique → accept/reject**.
3. Each iteration is logged to an **agent logbook** (JSON file in the worktree) with full traceability.
4. The UI shows real-time progress: iteration count, metric trajectory, and the logbook.

The loop terminates when the target is reached, max iterations are hit, or the user manually stops.

### Prior Art: Karpathy's autoresearch

This design is informed by [karpathy/autoresearch](https://github.com/karpathy/autoresearch), which applies the same core loop (modify → measure → keep/discard → repeat) to LLM training research. Key lessons incorporated from that project:

1. **Context window hygiene** — autoresearch redirects all experiment output to a log file and reads only key metrics via `grep`, preventing context flooding. We adopt the same principle with four layers: input truncation, session recycling (fresh session every N iterations with a compact handoff), output redirection guidance in the system prompt, and the logbook as external memory. See the dedicated [Context Window Hygiene](#context-window-hygiene) section.
2. **Crash resilience** — autoresearch handles crashes explicitly: attempt a fix, if it doesn't work after a few tries, log as "crash" and move on. We add the same crash-and-recover loop.
3. **Simplicity criterion** — autoresearch instructs the agent that "all else being equal, simpler is better. A tiny improvement that adds ugly complexity isn't worth it." We incorporate this into both the implementation prompt and the critique prompt.
4. **Never stop** — autoresearch runs indefinitely until manually interrupted. We support this via an optional `maxIterations` (default 25, set to 0 for unlimited).

Where we diverge from autoresearch (intentionally):
- **`git revert` vs `git reset`** — autoresearch uses `git reset` for cleaner history. We use `git revert` for full traceability, since production codebases benefit from seeing what was tried and rejected.
- **Critiquer step** — autoresearch has no post-hoc critique; it relies on the agent's judgment during implementation. We add an explicit critique phase because production codebases need stronger safeguards against metric gaming and unmaintainable hacks.
- **Structured logbook** — autoresearch uses a simple TSV. We use a structured JSON logbook with richer metadata (diffs, critique notes, commit refs) suitable for UI display.

---

## Iteration Loop (Core Algorithm)

```
┌─────────────────────────────────────────────────────────────┐
│                    SETUP PHASE                              │
│  1. Run test command → capture baseline output              │
│  2. LLM judges baseline metric value from output            │
│  3. Log baseline to logbook                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  ITERATION N                                │
│                                                             │
│  IMPLEMENT PHASE                                            │
│  1. Send prompt to ACP session:                             │
│     "Here is the current metric: X. Target: Y.             │
│      Here is the test output (truncated). Analyze the       │
│      codebase and implement changes to improve the metric." │
│  2. LLM makes code changes (via ACP tool calls)             │
│  3. Wait for session to go idle (implementation done)        │
│                                                             │
│  MEASURE PHASE                                              │
│  4. Git commit all changes (message: "auto-iter-N: ...")    │
│  5. Run test command → capture output TO FILE               │
│  6. Truncate output (keep last 200 lines + any summary      │
│     lines matching common patterns like "PASS", "FAIL",     │
│     "total", "coverage", etc.)                              │
│  7. Send truncated output to LLM: "Compare old vs new       │
│     metric. Respond with structured JSON."                  │
│                                                             │
│  CRASH HANDLING (between steps 5-7)                         │
│  - If test command exits non-zero or times out:             │
│    → Attempt fix: send error output to LLM, ask to fix     │
│    → Re-run test command (max 2 fix attempts per iteration) │
│    → If still failing: git revert, log as "crashed",        │
│      move to next iteration                                 │
│                                                             │
│  EVALUATE PHASE                                             │
│  8a. If REGRESSED or NO CHANGE:                             │
│      → git revert the commit                                │
│      → Log attempt with status "rejected_regression"        │
│      → Continue to next iteration                           │
│  8b. If IMPROVED:                                           │
│      → Continue to critique                                 │
│                                                             │
│  CRITIQUE PHASE                                             │
│  9. Send prompt to same session (critiquer persona):        │
│     "As a critical code reviewer, examine this diff.        │
│      Is this a legitimate improvement or a workaround?      │
│      Does it game the metric? Is it maintainable?           │
│      Is the complexity cost worth the improvement?"         │
│  10a. If REJECTED by critiquer:                             │
│       → git revert the commit                               │
│       → Log with status "rejected_critique"                 │
│  10b. If APPROVED:                                          │
│       → Keep the commit                                     │
│       → Log with status "accepted"                          │
│                                                             │
│  CHECK TERMINATION                                          │
│  11. If target reached → stop, status = "COMPLETED"         │
│  12. If max > 0 and iteration >= max → stop,                │
│      status = "MAX_ITERATIONS"                              │
│                                                             │
│  SESSION RECYCLING                                          │
│  13. If iteration % sessionRecycleInterval == 0:            │
│      → Stop current ACP session                             │
│      → Build handoff prompt from logbook (compact summary   │
│        of all iterations, failed approaches, current state) │
│      → Start fresh ACP session with handoff prompt          │
│  14. Continue to next iteration                             │
└─────────────────────────────────────────────────────────────┘
```

### Context Window Hygiene

Running 25+ iterations in a single ACP session is a context window management problem. Each iteration adds test output, tool call results (file reads, command runs), git diffs, and LLM responses to the conversation history. Without mitigation, the context fills up, the provider starts truncating earlier messages, and the LLM loses track of what's been tried — re-attempting already-rejected approaches.

We use four layers of mitigation:

#### Layer 1: Truncate inputs before they enter the session

All external data sent to the LLM is truncated before injection:

- **Test output**: Kept to last 200 lines + extracted summary lines (see `truncateTestOutput` in the Running the Test Command section). Over 25 iterations, this alone saves ~100k tokens vs raw output.
- **Git diffs** (for critique): Large diffs are truncated to stat-summary + the first 500 lines of hunks. The LLM can always read the full diff via tool calls if needed.
- **Crash output**: Last 100 lines only.

#### Layer 2: Session recycling

This is the biggest lever. Instead of one long-lived ACP session for the entire run, we **start a fresh session every N iterations** (default: every 10). The new session receives a compact handoff prompt built from the logbook:

```
You are continuing an auto-iteration run. Here is your context:

ITERATION HISTORY (from logbook):
- #1: "Added tests for auth module." 47% → 52%. ACCEPTED.
- #2: "Refactored error handling." 52% → 50%. REJECTED (regression).
- #3: "Disabled flaky test." 50% → 54%. REJECTED (critique: gaming metric).
- #4: "Added edge case tests for parser." 52% → 58%. ACCEPTED.
...

APPROACHES THAT DIDN'T WORK:
- Refactoring error handling (caused regression)
- Disabling tests (rejected by critique as metric gaming)

CURRENT STATE:
- Current metric: 61% coverage
- Target: 90% coverage
- Iterations completed: 10, Accepted: 6, Rejected: 3, Crashed: 1

The codebase already contains all accepted changes. Continue iterating.
```

This gives the LLM everything it needs (what worked, what didn't, current state) without carrying 10 iterations of full conversation history. The logbook serves as external memory that survives across session boundaries.

**When to recycle**: The service tracks a `sessionIterationCount`. When it reaches the configured `sessionRecycleInterval` (default 10), the current session is stopped and a new one is started with the handoff prompt. The interval is configurable because optimal recycling depends on context window size and iteration complexity.

#### Layer 3: Output redirection for tool calls

The system prompt instructs the LLM to redirect verbose command output to files:

```
When running commands that produce large output, redirect to a file
and read only the relevant parts:
  command > /tmp/output.log 2>&1
  tail -n 50 /tmp/output.log
  grep -E "PASS|FAIL|error" /tmp/output.log
```

This mirrors autoresearch's `uv run train.py > run.log 2>&1` + `grep "^val_bpb:" run.log` pattern. It prevents the LLM's own tool calls from flooding the context window — the biggest source of uncontrolled context growth.

#### Layer 4: Logbook as external memory

The JSON logbook at `.factory-factory/auto-iteration-logbook.json` serves double duty:

1. **UI display** — the frontend reads it for the iteration log view
2. **LLM external memory** — on session recycling, the handoff prompt is built from the logbook rather than from conversation history. The LLM can also read the logbook directly via file read tool calls if it needs to revisit earlier iteration details.

This means no iteration context is ever truly lost — it's just moved from expensive conversation history to a cheap file on disk.

### Why same-session critique (not a separate session)

The critiquer uses the **same ACP session** with a role-shifted prompt rather than a separate session. This is simpler:
- No second session lifecycle to manage
- The LLM already has full context of what it changed and why
- Fewer resources consumed (one process, one context window)
- Bias is mitigated through an explicitly adversarial system prompt that instructs the LLM to look for workarounds, metric gaming, and unmaintainable code

### Why LLM-based metric evaluation (not parsed numbers)

The test command output is evaluated by the LLM rather than a regex/parser because:
- Supports arbitrary output formats without configuration
- Handles "higher is better" and "lower is better" automatically
- Can interpret nuanced results (e.g., "3 tests pass but 1 new test was added")
- The user's target description is natural language anyway

The LLM is asked to respond with structured JSON for the evaluation, so the backend can reliably parse the result.

---

## Data Model Changes

### Prisma Schema

```prisma
// New enum
enum WorkspaceMode {
  STANDARD
  AUTO_ITERATION
}

// New enum
enum AutoIterationStatus {
  IDLE           // Configured but not started
  RUNNING        // Loop is actively iterating
  PAUSED         // User paused the loop
  COMPLETED      // Target reached
  MAX_ITERATIONS // Hit iteration limit
  STOPPED        // User manually stopped
  FAILED         // Unrecoverable error
}

// New fields on Workspace model
model Workspace {
  // ... existing fields ...

  // Auto-iteration fields
  mode                    WorkspaceMode        @default(STANDARD)
  autoIterationStatus     AutoIterationStatus?
  autoIterationConfig     Json?     // { testCommand, targetDescription, maxIterations }
  autoIterationProgress   Json?     // { currentIteration, baselineMetric, currentMetric, ... }
  autoIterationSessionId    String?  // Active ACP session for auto-iteration loop
}
```

### AutoIterationConfig (JSON shape)

```typescript
interface AutoIterationConfig {
  testCommand: string;           // Shell command to run in worktree
  targetDescription: string;     // Natural language target for LLM
  maxIterations: number;         // Default: 25, 0 = unlimited (runs until stopped)
  testTimeoutSeconds: number;    // Max time for test command (default: 300 = 5 min)
  sessionRecycleInterval: number; // Start fresh session every N iterations (default: 10)
}
```

### AutoIterationProgress (JSON shape)

```typescript
interface AutoIterationProgress {
  currentIteration: number;
  baselineMetricSummary: string;   // LLM's description of the baseline
  currentMetricSummary: string;    // LLM's description of current state
  acceptedCount: number;
  rejectedRegressionCount: number;
  rejectedCritiqueCount: number;
  crashedCount: number;
  sessionRecycleCount: number;     // How many times the session has been recycled
  startedAt: string;               // ISO timestamp
  lastIterationAt: string | null;
}
```

### Agent Logbook (JSON file in worktree)

Located at `.factory-factory/auto-iteration-logbook.json` in the workspace worktree.

```typescript
interface AgentLogbook {
  workspaceId: string;
  config: AutoIterationConfig;
  baseline: {
    testOutput: string;
    metricSummary: string;
    evaluatedAt: string;
  };
  iterations: AgentLogbookEntry[];
}

interface AgentLogbookEntry {
  iteration: number;
  startedAt: string;
  completedAt: string;
  status: 'accepted' | 'rejected_regression' | 'rejected_critique' | 'crashed';

  // What the LLM changed
  changeDescription: string;    // LLM's description of what it did
  commitSha: string;            // The commit hash (before potential revert)
  commitReverted: boolean;

  // Metric evaluation
  metricBefore: string;         // LLM's summary of metric before
  metricAfter: string | null;   // LLM's summary of metric after (null if crashed)
  testOutput: string;           // Test command output (truncated to last 200 lines)
  metricImproved: boolean | null; // null if crashed

  // Crash info (only if status is 'crashed')
  crashError: string | null;    // Error message / stack trace
  fixAttempts: number;          // Number of fix attempts before giving up (max 2)

  // Critique (only if metric improved)
  critiqueNotes: string | null;
  critiqueApproved: boolean | null;
}
```

---

## New Service Capsule: `auto-iteration`

### Registration

```typescript
// src/backend/services/registry.ts
'auto-iteration': {
  dependsOn: ['session', 'workspace', 'run-script'],
  ownsModels: [],  // Uses Workspace model fields, no new tables
}
```

### Service Structure

```
src/backend/services/auto-iteration/
├── index.ts                           # Barrel file (public API)
├── service/
│   ├── auto-iteration.service.ts      # Main loop orchestration
│   ├── auto-iteration.types.ts        # Shared types
│   ├── metric-evaluation.service.ts   # LLM metric judgment prompts
│   ├── critique.service.ts            # LLM critique prompts
│   ├── logbook.service.ts             # Read/write logbook JSON file
│   └── bridges.ts                     # Cross-service bridge interfaces
```

### Bridge Interfaces

```typescript
interface AutoIterationSessionBridge {
  startSession(workspaceId: string, systemPrompt: string): Promise<string>; // returns sessionId
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
  waitForIdle(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getLastAssistantMessage(sessionId: string): Promise<string>;
  recycleSession(workspaceId: string, handoffPrompt: string): Promise<string>; // stop old, start new, returns new sessionId
}

interface AutoIterationWorkspaceBridge {
  getWorktreePath(workspaceId: string): Promise<string>;
  updateProgress(workspaceId: string, progress: AutoIterationProgress): Promise<void>;
  updateStatus(workspaceId: string, status: AutoIterationStatus): Promise<void>;
}
```

### Core Loop (auto-iteration.service.ts)

```typescript
class AutoIterationService {
  // Start the auto-iteration loop for a workspace
  async start(workspaceId: string): Promise<void>;

  // Pause (between iterations only)
  async pause(workspaceId: string): Promise<void>;

  // Resume from paused state
  async resume(workspaceId: string): Promise<void>;

  // Stop immediately (finishes current iteration, then stops)
  async stop(workspaceId: string): Promise<void>;

  // Get current status + progress
  getStatus(workspaceId: string): AutoIterationSnapshot;
}
```

The `start()` method:
1. Validates workspace is in `AUTO_ITERATION` mode with config present
2. Sets status to `RUNNING`
3. Runs the baseline measurement
4. Enters the iteration loop (each iteration is a separate async step)
5. Between iterations, checks for pause/stop signals
6. On completion, sets terminal status and stops the ACP session

### Running the Test Command

Uses the same subprocess spawning pattern as `run-script.service.ts`:

```typescript
async function runTestCommand(worktreePath: string, command: string, timeoutSeconds: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  // spawn('bash', ['-c', command], { cwd: worktreePath })
  // Redirect output to temp file: command > .factory-factory/test-output.log 2>&1
  // Timeout after configured limit (default: 300s)
  // On timeout: kill process, set timedOut = true
  // Return combined output for LLM evaluation
}
```

This is intentionally **not** the run-script service — auto-iteration test commands are short-lived measurement commands (run-to-completion), while run-script manages long-running dev servers. A simple `child_process.spawn` wrapper is sufficient.

### Output Truncation (Context Window Hygiene)

Inspired by autoresearch's approach of redirecting output to files and reading only key lines, test output is truncated before being sent to the LLM:

```typescript
function truncateTestOutput(raw: string, maxLines = 200): string {
  const lines = raw.split('\n');
  if (lines.length <= maxLines) return raw;

  // Extract summary lines (common test framework patterns)
  const summaryPatterns = /pass|fail|error|total|coverage|%|result|summary|assert/i;
  const summaryLines = lines.filter(l => summaryPatterns.test(l));

  // Keep last N lines (most relevant) + summary lines from earlier
  const tail = lines.slice(-maxLines);
  const earlySummary = summaryLines.filter(l => !tail.includes(l));

  return [
    `[... ${lines.length - maxLines} lines truncated ...]`,
    ...earlySummary.slice(0, 20),
    '---',
    ...tail,
  ].join('\n');
}
```

This prevents context window exhaustion across many iterations — critical for runs with 25+ iterations.

### Git Operations

Between iterations, the service interacts with git directly in the worktree:

```typescript
// After LLM implements changes:
git add -A && git commit -m "auto-iteration #N: <change description>"

// On rejection (regression or critique):
git revert HEAD --no-edit

// On acceptance:
// No action needed — commit stays
```

Using `git revert` (not `git reset`) so the history shows what was tried and rejected. The revert commit message will reference the original.

---

## tRPC API

### New Procedures

```typescript
// src/backend/trpc/auto-iteration.trpc.ts

autoIteration.start        // Start the loop for a workspace
autoIteration.pause        // Pause between iterations
autoIteration.resume       // Resume from pause
autoIteration.stop         // Stop the loop
autoIteration.getStatus    // Get current iteration + progress
autoIteration.getLogbook   // Read the logbook file from worktree
```

### Workspace Creation Extension

Extend the existing `workspace.create` mutation to accept `AUTO_ITERATION` mode:

```typescript
// In the MANUAL creation source, add:
{
  type: 'MANUAL',
  projectId: string,
  name: string,
  mode?: 'AUTO_ITERATION',           // NEW
  autoIterationConfig?: {             // NEW — required when mode is AUTO_ITERATION
    testCommand: string,
    targetDescription: string,
    maxIterations?: number,           // Default: 25, 0 = unlimited
    testTimeoutSeconds?: number,      // Default: 300
    sessionRecycleInterval?: number,  // Default: 10
  },
  // ... existing fields
}
```

---

## UI Changes

### 1. Launch Button — Split Button Pattern

Replace the current launch button in `inline-workspace-form.tsx` with a **split button**:

```
┌──────────────────┬───┐
│   Launch         │ ▾ │
└──────────────────┴───┘
                     │
                     ▼
              ┌──────────────────┐
              │ Auto-Iteration   │
              └──────────────────┘
```

- **Left side**: Normal launch (existing behavior)
- **Right side (chevron)**: Opens dropdown with "Auto-Iteration" option
- Clicking "Auto-Iteration" switches the form to auto-iteration mode

**Why split button over long-press**: Split buttons are a standard, accessible UI pattern. Long-press has poor discoverability, no keyboard equivalent, and conflicts with mobile touch interactions.

### 2. Auto-Iteration Configuration Form

When auto-iteration mode is selected, the inline form shows additional fields:

```
┌─────────────────────────────────────────────┐
│  What should the agent optimize?            │
│  ┌─────────────────────────────────────────┐│
│  │ Increase test coverage to 90%           ││
│  └─────────────────────────────────────────┘│
│                                             │
│  Test command                               │
│  ┌─────────────────────────────────────────┐│
│  │ pnpm test:coverage                      ││
│  └─────────────────────────────────────────┘│
│                                             │
│  Target                                     │
│  ┌─────────────────────────────────────────┐│
│  │ Coverage reaches 90% across all files   ││
│  └─────────────────────────────────────────┘│
│                                             │
│  Max iterations  ┌──────┐  ☐ Unlimited       │
│                  │  25  │                   │
│                  └──────┘                   │
│                                             │
│  Test timeout    ┌──────┐                   │
│                  │ 300s │                   │
│                  └──────┘                   │
│                                             │
│  ┌──────────────────┬───┐                   │
│  │   Launch         │ ▾ │                   │
│  └──────────────────┴───┘                   │
└─────────────────────────────────────────────┘
```

### 3. Kanban Card — Auto-Iteration Badge

Auto-iteration workspaces show a distinct badge on the kanban card:

- **Badge**: iteration count indicator (e.g., "Iter 3/25")
- **Color coding**: Same as standard workspaces (brand for working, amber for waiting)
- **Tooltip**: Shows current metric summary on hover

### 4. Workspace Detail Page — Auto-Iteration View

When viewing an auto-iteration workspace, the detail page shows a specialized layout:

```
┌─────────────────────────────────────────────────────────────┐
│  [Session Tabs]  [Auto-Iteration Progress]   [Pause] [Stop] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Progress Panel ───────────────────────────────────────┐ │
│  │  Iteration: 7 / 25                                     │ │
│  │  Accepted: 4  │  Rejected (regression): 2  │  Rejected │ │
│  │  (critique): 1  │  Crashed: 0                          │ │
│  │                                                        │ │
│  │  Baseline: "47% test coverage"                         │ │
│  │  Current:  "72% test coverage"                         │ │
│  │  Target:   "90% test coverage"                         │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Iteration Log ───────────────────────────────────────┐  │
│  │                                                       │  │
│  │  ✓ #7 — accepted                                      │  │
│  │    "Added tests for UserService.authenticate()"       │  │
│  │    47% → 52% coverage  │  commit abc1234              │  │
│  │    Critique: "Legitimate improvement. Tests cover..."  │  │
│  │                                                       │  │
│  │  ✗ #6 — rejected (critique)                           │  │
│  │    "Disabled flaky tests to improve pass rate"        │  │
│  │    47% → 49% coverage  │  commit def5678 (reverted)   │  │
│  │    Critique: "This disables tests rather than..."     │  │
│  │                                                       │  │
│  │  ✗ #5 — rejected (regression)                         │  │
│  │    "Refactored auth module to use dependency..."      │  │
│  │    52% → 47% coverage  │  commit ghi9012 (reverted)   │  │
│  │                                                       │  │
│  │  ... (expandable/scrollable)                          │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Agent Chat (collapsed, expandable) ──────────────────┐  │
│  │  [Full ACP session transcript]                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 5. WebSocket Events

New event types for real-time progress updates:

```typescript
type AutoIterationEvent =
  | { type: 'auto_iteration_started'; workspaceId: string; baseline: string }
  | { type: 'auto_iteration_progress'; workspaceId: string; progress: AutoIterationProgress }
  | { type: 'auto_iteration_entry'; workspaceId: string; entry: AgentLogbookEntry }
  | { type: 'auto_iteration_completed'; workspaceId: string; finalStatus: AutoIterationStatus }
```

---

## Prompt Design

### System Prompt (for the ACP session)

```
You are an auto-iteration agent. Your job is to improve a codebase
against a specific metric through targeted, incremental changes.

METRIC CONFIGURATION:
- Test command: {testCommand}
- Target: {targetDescription}

RULES:
- Make small, focused changes per iteration. One logical change at a time.
- Each change should directly target improving the metric.
- Do not game the metric (e.g., disabling tests, hardcoding values,
  disabling checks, or any form of shortcut that doesn't represent
  genuine improvement).
- Do not make changes unrelated to the metric target.
- SIMPLICITY CRITERION: All else being equal, simpler is better. A small
  improvement that adds ugly complexity is not worth it. Removing code
  and getting equal or better results is a great outcome. Weigh the
  complexity cost against the improvement magnitude.
- After making changes, stop and wait for the next instruction.
- If your changes cause the test command to crash, you may be asked to
  fix the issue. If you can't fix it after a couple of attempts, say so
  and the change will be reverted.

CONTEXT MANAGEMENT:
- When running commands that produce large output, redirect to a file
  and read only the relevant parts:
    command > /tmp/output.log 2>&1
    tail -n 50 /tmp/output.log
    grep -E "PASS|FAIL|error" /tmp/output.log
- Do NOT dump entire file contents into the conversation. Read only
  the sections relevant to your current change.
- Your iteration history is recorded in
  .factory-factory/auto-iteration-logbook.json — you can read this
  file to review what has been tried before.
```

### Measure Prompt (sent after test command runs)

Note: All interpolated values inside XML-like blocks (e.g., `<test_output>`) are
escaped at runtime via `escapeXmlContent()` which replaces `</` with `<\/` to
prevent prompt-boundary injection from external content.

```
The test command has been run. Here is the output:

<test_output>
{escapeXmlContent(testCommandOutput)}
</test_output>

Previous metric state: {previousMetricSummary}

Evaluate the current metric state from this output. Respond with JSON:
{
  "metricSummary": "...",     // Human-readable summary of current metric
  "improved": true/false,     // Did the metric improve vs previous?
  "targetReached": true/false // Has the target been reached?
}
```

### Crash Fix Prompt (sent when test command fails after changes)

```
The test command crashed after your changes. Here is the error output
(last 100 lines):

<error_output>
{escapeXmlContent(truncatedErrorOutput)}
</error_output>

This is fix attempt {attemptNumber}/2. Diagnose the issue and fix it.
If the problem is fundamental to your approach (not just a typo or
missing import), say "UNFIXABLE" and the change will be reverted.
```

### Critique Prompt (sent after metric improvement confirmed)

```
ROLE SWITCH: You are now a critical code reviewer, not the implementer.

Review the changes you just made with extreme scrutiny. The diff is:

<diff>
{escapeXmlContent(gitDiff)}
</diff>

Evaluate whether this change is:
1. A legitimate improvement (good engineering, maintainable, correct)
2. A workaround or hack (gaming the metric, fragile, unmaintainable)
3. Potentially harmful (introduces bugs, security issues, tech debt)
4. Worth the complexity cost (a 0.1% improvement that adds 50 lines of
   hacky code is NOT worth it; a 0.1% improvement from deleting code IS)

Respond with JSON:
{
  "approved": true/false,
  "notes": "..."  // Detailed critique
}
```

---

## Implementation Plan

### Phase 1: Data Model & Service Skeleton
1. Add `WorkspaceMode`, `AutoIterationStatus` enums to Prisma schema
2. Add auto-iteration fields to `Workspace` model
3. Run migration
4. Create `auto-iteration` service capsule skeleton
5. Register in `registry.ts`

### Phase 2: Core Loop
1. Implement `logbook.service.ts` (read/write logbook JSON)
2. Implement `metric-evaluation.service.ts` (LLM metric judgment)
3. Implement `critique.service.ts` (LLM critique prompts)
4. Implement `auto-iteration.service.ts` (main loop orchestration)
5. Wire up bridges to session and workspace services

### Phase 3: tRPC API
1. Create `auto-iteration.trpc.ts` with start/pause/resume/stop/status/logbook
2. Extend `workspace.create` to accept `AUTO_ITERATION` mode
3. Add WebSocket event forwarding for progress updates

### Phase 4: UI — Launch & Configuration
1. Convert launch button to split button in `inline-workspace-form.tsx`
2. Add auto-iteration configuration fields (test command, target, max iterations)
3. Wire up workspace creation with mode + config

### Phase 5: UI — Progress & Logbook
1. Add auto-iteration progress panel to workspace detail page
2. Add iteration log viewer (expandable entries)
3. Add kanban card badge for iteration count
4. Add pause/stop controls
5. Wire up WebSocket event listeners for real-time updates

### Phase 6: Testing & Polish
1. Unit tests for logbook, metric evaluation, critique services
2. Integration test for the iteration loop (mocked ACP)
3. Edge cases: test command timeout, LLM returns malformed JSON, workspace archived mid-loop
4. UI polish: loading states, error handling, empty states

---

## Open Questions / Future Work

- **Multiple test commands**: Could support running several metrics in parallel (e.g., coverage AND performance). Out of scope for v1.
- **Branching strategies**: Could create a branch per iteration attempt rather than reverting. Adds complexity for v1.
- **Cost tracking**: LLM token usage per iteration would be useful to surface. Can be added once ACP exposes token counts.
- **Separate critiquer model**: Using a different (possibly cheaper or more capable) model for critique. Requires multi-session support, deferred.
- **Workspace conversion**: Allowing conversion between standard and auto-iteration workspaces. Explicitly out of scope per requirements.
