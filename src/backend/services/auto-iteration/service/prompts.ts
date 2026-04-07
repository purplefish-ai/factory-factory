import type {
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
} from './auto-iteration.types';

/**
 * Escape content interpolated into XML-like prompt blocks to prevent
 * prompt-boundary injection if the content contains closing tag sequences.
 */
function escapeXmlContent(content: string): string {
  return content.replace(/<\//g, '<\\/');
}

export function buildSystemPrompt(
  config: AutoIterationConfig,
  insightsContent?: string | null
): string {
  const insightsBlock = insightsContent
    ? `\nINSIGHTS FROM PREVIOUS RUNS (.factory-factory/auto-iteration-insights.md):
<insights>
${escapeXmlContent(insightsContent)}
</insights>
Use these as starting points and context. Do not repeat approaches already recorded as obsolete.
`
    : '';

  return `You are an auto-iteration agent. Your job is to improve a codebase against a specific metric through targeted, incremental changes.

TARGET: ${config.targetDescription}

ROLE SEPARATION — READ THIS CAREFULLY:
You are the IMPLEMENTER. An external framework controls the iteration loop around you.
The framework's job: run the test command, measure metrics, evaluate improvement, critique changes, and decide whether to keep or revert.
Your job: make ONE focused code change per turn, then STOP. That's it.

- Do NOT run the test command (\`${config.testCommand}\`) or any variation of it.
- Do NOT run test suites, build commands, or linters to verify your changes.
- Do NOT try to confirm whether your change works. The framework will do that.
- You MAY use the terminal for read-only exploration: reading files (cat, grep, find, head, tail), checking types to understand code (tsc --noEmit), and listing directories. These are allowed because they help you navigate the codebase, not verify correctness.
- After making your code change, STOP IMMEDIATELY and wait for the next instruction.

If you run the test command yourself, you waste the iteration budget and duplicate work the framework already handles. The framework will tell you the test results after each change.

RULES:
- Make small, focused changes. One logical change at a time.
- Each change should directly target improving the metric.
- Do not game the metric (e.g., disabling tests, hardcoding values, disabling checks, or any form of shortcut that doesn't represent genuine improvement).
- Do not make changes unrelated to the metric target.
- SIMPLICITY CRITERION: All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Removing code and getting equal or better results is a great outcome. Weigh the complexity cost against the improvement magnitude.
- If your changes cause the test command to crash, you may be asked to fix the issue. If you can't fix it after a couple of attempts, say so and the change will be reverted.

CONTEXT MANAGEMENT:
- Do NOT dump entire file contents into the conversation. Read only the sections relevant to your current change.
- When reading files, use targeted reads (grep, head, tail) rather than reading whole files.
- Your iteration history is recorded in .factory-factory/auto-iteration-logbook.json — you can read this file to review what has been tried before.

INSIGHTS FILE:
- You have a persistent insights file at .factory-factory/auto-iteration-insights.md.
- Use it to record ideas, hypotheses, deferred approaches, or observations that might help attain the target in future runs.
- Write to it whenever you notice something worth preserving — you do not need to wait for a specific phase.
- You may also mark old entries as [resolved] or [obsolete], and trim the file to remove clutter when appropriate.
- Untagged entries and entries tagged [open] will be shown to you at the start of future runs.

STRATEGY FILE:
- The user may provide guidance in .factory-factory/auto-iteration-strategy.md
- This file is read at the start of each iteration — if it exists, follow the guidance within it
- The user can edit this file between iterations to steer your approach without restarting the loop
${insightsBlock}`;
}

export function buildImplementPrompt(
  currentMetricSummary: string,
  targetDescription: string,
  truncatedTestOutput: string,
  strategyContent?: string | null
): string {
  const strategySection = strategyContent
    ? `\n\nUSER STRATEGY (from .factory-factory/auto-iteration-strategy.md):\n\n<strategy>\n${escapeXmlContent(strategyContent)}\n</strategy>\n`
    : '';

  return `The current metric state is: ${currentMetricSummary}
Target: ${targetDescription}
${strategySection}
Here is the most recent test output (truncated):

<test_output>
${escapeXmlContent(truncatedTestOutput)}
</test_output>

Analyze the codebase and implement a single focused change to improve the metric toward the target.

IMPORTANT: Do NOT run the test command or any build/lint commands to verify your change. Make your code change and STOP. The framework will run the tests and tell you the results.`;
}

export function buildMeasurePrompt(
  truncatedTestOutput: string,
  previousMetricSummary: string
): string {
  return `The test command has been run. Here is the output:

<test_output>
${escapeXmlContent(truncatedTestOutput)}
</test_output>

Previous metric state: ${previousMetricSummary}

Evaluate the current metric state from this output. Respond with ONLY a JSON object (no markdown, no explanation):
{
  "metricSummary": "...",
  "improved": true/false,
  "targetReached": true/false
}`;
}

export function buildCrashFixPrompt(truncatedErrorOutput: string, attemptNumber: number): string {
  return `The test command crashed after your changes. Here is the error output (last 100 lines):

<error_output>
${escapeXmlContent(truncatedErrorOutput)}
</error_output>

This is fix attempt ${attemptNumber}/2. Diagnose the issue and fix it.
If the problem is fundamental to your approach (not just a typo or missing import), say "UNFIXABLE" and the change will be reverted.`;
}

export function buildCritiquePrompt(gitDiff: string): string {
  return `ROLE SWITCH: You are now a critical code reviewer, not the implementer.

Review the changes you just made with extreme scrutiny. The diff is:

<diff>
${escapeXmlContent(gitDiff)}
</diff>

Evaluate whether this change is:
1. A legitimate improvement (good engineering, maintainable, correct)
2. A workaround or hack (gaming the metric, fragile, unmaintainable)
3. Potentially harmful (introduces bugs, security issues, tech debt)
4. Worth the complexity cost (a 0.1% improvement that adds 50 lines of hacky code is NOT worth it; a 0.1% improvement from deleting code IS)

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "approved": true/false,
  "notes": "..."
}`;
}

export function buildCreatePrPrompt(
  config: AutoIterationConfig,
  progress: AutoIterationProgress,
  status: string
): string {
  const statusLabel =
    status === 'COMPLETED'
      ? 'the target was reached'
      : status === 'MAX_ITERATIONS'
        ? `the maximum of ${config.maxIterations} iterations was reached`
        : `the run ended (${status.toLowerCase()})`;

  return `The auto-iteration session is finishing — ${statusLabel}.

RESULTS:
- Target: ${config.targetDescription}
- Iterations completed: ${progress.currentIteration}
- Accepted improvements: ${progress.acceptedCount}
- Metric: ${progress.baselineMetricSummary} → ${progress.currentMetricSummary}

Your final task is to create a pull request for the changes made during this session. Run \`gh pr create\` with:
- A concise title describing the improvement (e.g. "Improve <metric> via auto-iteration")
- A body summarising what changed and what the metric improvement was

Do NOT make any additional code changes. Only create the pull request.`;
}

export function buildStrategyFileTemplate(config: AutoIterationConfig): string {
  return `# Auto-Iteration Strategy

Target: ${config.targetDescription}
Test command: ${config.testCommand}

## Guidance for the agent

<!--
Edit this file between iterations to steer the agent.
The agent reads it fresh at the start of each iteration.
You can add hints, constraints, or focus areas below.
-->
`;
}

export function buildHandoffPrompt(
  config: AutoIterationConfig,
  entries: AgentLogbookEntry[],
  currentMetricSummary: string,
  insightsContent?: string | null
): string {
  const history = entries
    .map((e) => {
      const metricChange =
        e.metricAfter != null ? `${e.metricBefore} → ${e.metricAfter}` : e.metricBefore;
      return `- #${e.iteration}: "${e.changeDescription}" ${metricChange}. ${e.status.toUpperCase()}.${e.critiqueNotes ? ` Critique: ${e.critiqueNotes}` : ''}`;
    })
    .join('\n');

  const rejectedApproaches = entries
    .filter((e) => e.status !== 'accepted')
    .map((e) => `- ${e.changeDescription} (${e.status})`)
    .join('\n');

  const accepted = entries.filter((e) => e.status === 'accepted').length;
  const rejected = entries.filter((e) => e.status !== 'accepted').length;

  const insightsBlock = insightsContent
    ? `\nINSIGHTS (from auto-iteration-insights.md):
<insights>
${escapeXmlContent(insightsContent)}
</insights>
`
    : '';

  return `You are continuing an auto-iteration run. Here is your context:

ITERATION HISTORY (from logbook):
${history}

APPROACHES THAT DIDN'T WORK:
${rejectedApproaches || '(none yet)'}

CURRENT STATE:
- Current metric: ${currentMetricSummary}
- Target: ${config.targetDescription}
- Iterations completed: ${entries.length}, Accepted: ${accepted}, Rejected: ${rejected}
${insightsBlock}
The codebase already contains all accepted changes.

NOTE: The user may have placed guidance in .factory-factory/auto-iteration-strategy.md — if it exists, follow its guidance for future iterations.

Continue iterating.`;
}
