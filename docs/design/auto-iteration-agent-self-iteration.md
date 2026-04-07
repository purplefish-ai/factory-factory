# Auto-Iteration: Agent Self-Iteration Problem

## Problem Statement

The auto-iteration loop is designed as a framework-controlled cycle: **measure → implement → measure → evaluate → critique → accept/reject**. The framework owns the iteration lifecycle — it runs the test command, commits changes, evaluates metrics via LLM, critiques the diff, and decides whether to keep or revert.

In practice, the agent inside the "implement" step is **running its own internal iteration cycle** that duplicates the framework's job. The agent reads code, makes changes, runs the test command to verify, sees failures, makes more changes, runs tests again, and repeats — all within a single `sendPrompt()` call. The framework has zero visibility into this.

The result: iterations take an extremely long time (consuming the full 20-minute prompt timeout), the UI stays stuck on "Implementing" with no phase transitions, and completed iterations are rarely or never recorded in the logbook.

## Symptoms

1. **Phase stuck on "Implementing"** — The UI progress banner shows "Implementing" indefinitely. No transitions to measuring, evaluating, or critiquing are visible.
2. **No iterations completing** — The logbook remains empty or nearly empty despite the loop running for extended periods.
3. **Very low throughput** — The iterations/hour metric (when any iterations complete) is far below what the loop architecture was designed for.
4. **Agent consuming the full timeout budget** — Each implement step takes the entire 20-minute `promptTimeoutSeconds` window before the timeout fires and records a crashed entry, or the agent eventually finishes one very large internal cycle.

## Root Cause Analysis

### 1. `sendPrompt()` is fully blocking with no intermediate visibility

The bridge implementation reveals that `sendPrompt()` blocks for the **entire duration** of the agent's turn:

```
auto-iteration.service.ts                      domain-bridges.orchestrator.ts
─────────────────────────                      ──────────────────────────────
sendPrompt(sessionId, prompt, timeoutMs)  →    sessionService.sendAcpMessage(sessionId, ...)
                                                    └→ runtimeManager.sendPrompt(sessionId, ...)
                                                           └→ handle.connection.prompt(...)  // blocks until stopReason
```

And `waitForIdle()` is a no-op:

```typescript
// domain-bridges.orchestrator.ts:289-291
async waitForIdle(_sessionId) {
  // sendAcpMessage already blocks until the turn completes
}
```

This means the auto-iteration loop has **no way to observe or interrupt** what the agent is doing during the implement step. The phase remains at `implementing` for the entire duration, and no progress is surfaced to the UI until `sendPrompt()` returns.

### 2. The agent has unrestricted terminal access during the implement step

The agent runs as an ACP session with full tool access: file read/write, terminal execution, etc. The test command is disclosed in the system prompt:

```
METRIC CONFIGURATION:
- Test command: {testCommand}
- Target: {targetDescription}
```

Nothing prevents the agent from running the test command itself. In fact, the system prompt encourages efficient command usage:

```
CONTEXT MANAGEMENT:
- When running commands that produce large output, redirect to a file and read only the relevant parts
```

### 3. The implement prompt is insufficient to prevent self-iteration

The current implement prompt ends with:

```
Analyze the codebase and implement a single focused change to improve
the metric toward the target. After making your changes, stop and wait
for the next instruction.
```

The instruction to "stop and wait" is not strong enough. Claude's natural behavior when given a goal and the means to verify it (the test command) is to verify its work before stopping. This is generally good agent behavior — but in this context it duplicates the framework's measure/evaluate/critique pipeline.

The agent's natural loop during a single implement step:

```
1. Read codebase to understand the problem
2. Make a change
3. Run the test command to verify          ← duplicates framework's MEASURE phase
4. See failures, make another change
5. Run tests again                         ← duplicates framework's MEASURE phase
6. Repeat until satisfied or timeout
```

### 4. The system prompt actively enables the self-iteration pattern

The system prompt tells the agent about the test command, the logbook, and the insights file. It also provides context management guidance for running commands. This gives the agent everything it needs to run its own test-fix cycles autonomously.

The system prompt's RULES section says:

```
- Make small, focused changes per iteration. One logical change at a time.
```

But the agent interprets "iteration" as its own internal iteration, not the framework's iteration.

## Impact

### Wasted resources
- **Timeout budget**: The agent consumes the full 20-minute timeout doing internal iterations, while the framework's own measure-evaluate-critique pipeline (which should take seconds) never gets a chance to run.
- **Context window**: Each internal test-fix cycle adds tool calls (terminal output, file reads, file writes) to the conversation history, consuming context that should be reserved for subsequent framework-controlled iterations.
- **Token costs**: The agent burns tokens on internal measurement and evaluation that the framework would do more cheaply with structured prompts and truncated output.

### Broken outer loop
- **No logbook entries**: The framework records iterations at the end of each outer loop cycle. If the agent self-iterates for 20 minutes and then times out, at most one "crashed" entry is recorded — the internal changes are invisible.
- **No critique gate**: The agent's internal changes bypass the framework's critique step entirely. The simplicity criterion and metric-gaming checks are never applied.
- **No git traceability**: The framework's commit-per-iteration model (with revert on rejection) is bypassed. The agent's internal changes are uncommitted until the framework commits them as one large batch.
- **No metric tracking**: The framework's metric trajectory (baseline → iteration 1 → iteration 2 → ...) collapses into a single data point because all internal iterations are invisible.

### UI appears broken
- The progress banner shows "Implementing" indefinitely with no phase transitions.
- Iterations/hour shows 0 or near-0.
- Users cannot tell if the loop is making progress or stuck.

## Potential Solutions

### Option A: Explicitly prohibit running the test command

Add a hard rule to the system prompt and implement prompt telling the agent it must NOT run the test command:

```
CRITICAL RULE: Do NOT run the test command ({testCommand}) yourself.
The framework will run it for you after each change. Your job is ONLY
to make code changes. Do not verify your changes — the framework
handles measurement, evaluation, and iteration.
```

**Pros**: Simple, no code changes needed (prompt-only fix).
**Cons**: The agent may still run the test command (LLMs don't always follow prohibitions). The agent may run similar commands (e.g., `pnpm test` when the test command is `pnpm test:coverage`). Hard to enforce programmatically.

### Option B: Prohibit test command + restrict terminal usage

Combine the prompt prohibition with stronger guidance:

```
CRITICAL RULES:
- Do NOT run the test command ({testCommand}) or any similar test/build
  commands. The framework handles all measurement.
- You may use the terminal ONLY for: reading files (cat, grep, find),
  checking types (tsc --noEmit), or other non-test operations.
- After making your code changes, STOP IMMEDIATELY. Do not verify them.
```

**Pros**: Stronger guidance. Gives the agent a clear mental model ("I'm the implementer, the framework is the tester").
**Cons**: Still prompt-based enforcement. May be overly restrictive (sometimes the agent benefits from running `tsc` to check for type errors before stopping).

### Option C: Enforce a terminal command allowlist/denylist at the ACP level

Configure the ACP session to reject or filter terminal commands matching the test command pattern.

**Pros**: Hard enforcement — the agent physically cannot run the test command.
**Cons**: Requires ACP-level changes. May be too blunt (the test command might be `npm test` but `npm run test:unit` should also be blocked). Pattern matching is fragile.

### Option D: Add a prompt-level time budget with intermediate check-ins

Instead of one long `sendPrompt()` call for the implement step, send shorter prompts with time constraints:

```
You have 2 minutes to make a single focused change. Do not run tests.
Make your change and respond with what you changed.
```

Then the framework checks for changes, commits, measures, evaluates, and critiques — as designed.

**Pros**: Limits the damage of self-iteration. Faster iteration cycles.
**Cons**: Artificial time pressure may reduce change quality. Requires prompt timeout tuning.

### Option E: Streaming phase detection (future)

Monitor the ACP session's tool calls in real-time during the implement step. If the agent attempts to run the test command, interrupt the session and proceed to the framework's measure step.

**Pros**: Perfect enforcement without restrictive prompts.
**Cons**: Requires significant infrastructure work (streaming tool call interception, session interruption mid-turn). Not currently supported by the ACP bridge architecture.

## Recommended Approach

**Start with Option B** (prompt-based prohibition) as an immediate fix. This is the lowest-effort change that directly addresses the root cause. The key additions:

1. **System prompt**: Add an explicit rule that the agent must not run the test command or any test/build verification commands. Clarify the framework's role vs the agent's role.
2. **Implement prompt**: Reinforce the prohibition and add a clear "stop after making changes" instruction with stronger language.
3. **Reduce prompt timeout**: Lower from 20 minutes to something like 3-5 minutes. A single focused code change should not take 20 minutes. A shorter timeout acts as a backstop if the agent ignores the prompt instructions.

If prompt-based enforcement proves insufficient, escalate to **Option C** (ACP-level command filtering) or **Option E** (streaming detection).

## Measuring Success

- **Iterations/hour** increases significantly (target: 5-15 iter/hr depending on test command speed, vs current near-0)
- **Phase transitions visible in UI** — the progress banner should cycle through measuring → implementing → measuring → evaluating → critiquing → idle regularly
- **Logbook entries accumulate** — each framework iteration records an entry within minutes, not hours
- **Agent terminal usage during implement** — monitor whether the agent still attempts to run the test command (visible in the ACP session transcript)
