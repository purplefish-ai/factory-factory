import { sessionModulesPath } from './baselines';
import type { AgentMetrics } from './collect';
import type { FollowUpFixes } from './pull-requests';
import type { Distribution, TimeWindow } from './statistics';
import { mockTargetClasses } from './vi-mocks';

function formatNumber(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toLocaleString('en-US')}${suffix}`;
}

function formatShare(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDistribution(value: Distribution, unit: string): string {
  return `median ${formatNumber(value.median, unit)}, p90 ${formatNumber(value.p90, unit)} (n=${formatNumber(value.count)})`;
}

function formatWindow(window: TimeWindow): string {
  return `${window.from ?? 'n/a'} to ${window.to ?? 'n/a'}`;
}

/**
 * A code span that survives backticks in `text` (the fence is longer than any
 * run inside it) and line breaks (shown as `\n` and `\r`).
 */
function code(raw: string): string {
  const text = raw.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = /^[`\s]|[`\s]$/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

/**
 * A code span inside a table cell, where `|` would otherwise end the cell.
 * Backslashes before a `|` are doubled so they cannot escape its escape.
 */
function tableCode(text: string): string {
  return code(text).replace(
    /(\\*)\|/g,
    (_match, backslashes: string) => `${backslashes}${backslashes}\\|`
  );
}

function formatFollowUpFixes(fixes: FollowUpFixes, merged: number): string {
  const numbers =
    fixes.numbers.length > 0 ? `: ${fixes.numbers.map((number) => `#${number}`).join(', ')}` : '';
  return `${formatNumber(fixes.referencingRecentMerge)} (${formatShare(fixes.shareOfMerged)} of ${formatNumber(merged)} merged PRs)${numbers}`;
}

export function renderMarkdown(metrics: AgentMetrics): string {
  const { ci, pullRequests } = metrics.github;
  const { tree } = metrics;
  const lines = [
    '# Agent workflow metrics',
    '',
    `Tree at \`${tree.commit}\`.`,
    '',
    '## Pull requests and CI',
    '',
    `CI: ${formatNumber(ci.runs)} \`pull_request\` runs of \`ci.yml\` (${formatNumber(ci.attempts)} attempts), started ${formatWindow(ci.window)} (the run window). Only runs in the run window count: a branch whose first run predates it is judged by its first run inside it.`,
    `Pull requests: ${formatNumber(pullRequests.merged)} merged, ${formatWindow(pullRequests.window)} (the PR window). A fix PR counts as a follow-up only through references to PRs merged in the PR window; references to PRs outside it are not counted.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| PR branches green on first non-cancelled run | ${formatNumber(ci.firstRun.greenOnFirstRun)} of ${formatNumber(ci.firstRun.decided)} (${formatShare(ci.firstRun.greenShare)}) |`,
    `| PR branches with any failed run | ${formatNumber(ci.firstRun.branchesWithFailure)} of ${formatNumber(ci.firstRun.branches)} |`,
    `| Pushes per PR branch | ${formatDistribution(ci.pushesPerBranch, '')} |`,
    `| CI duration, successful runs | ${formatDistribution(ci.successfulDurationMinutes, ' min')} |`,
    `| Commits that failed then passed | ${formatNumber(ci.failedThenPassedCommits)} |`,
    `| Open to merge | ${formatDistribution(pullRequests.openToMergeHours, ' h')} |`,
    `| Merged PRs titled with a fix verb | ${formatNumber(pullRequests.followUpFixes.fixTitled)} of ${formatNumber(pullRequests.merged)} |`,
    `| Fix PRs referencing a PR merged in the previous 7 days | ${formatFollowUpFixes(pullRequests.followUpFixes, pullRequests.merged)} |`,
    '',
    '## Guidance',
    '',
    '| Directory | Guide chain | Lines | Estimated tokens |',
    '| --- | --- | --- | --- |',
    ...tree.guideChains.map(
      (chain) =>
        `| ${tableCode(chain.directory)} | ${chain.guides.map(tableCode).join(' → ')} | ${formatNumber(chain.lines)} | ${formatNumber(chain.tokens)} |`
    ),
    '',
    `Guidance: ${formatNumber(tree.guidance.guidanceLines)} lines (\`AGENTS.md\` ${formatNumber(tree.guidance.guideLines)}, \`docs/architecture\` ${formatNumber(tree.guidance.architectureNoteLines)}) against ${formatNumber(tree.guidance.sourceLines)} production source lines under \`src/\`: ${formatNumber(tree.guidance.guidancePerThousandSourceLines)} per 1,000.`,
    '',
    `## Most-edited files (last ${formatNumber(tree.mostEditedFiles.commits)} commits)`,
    '',
    '| File | Commits | Share |',
    '| --- | --- | --- |',
    ...tree.mostEditedFiles.files.map(
      (file) =>
        `| ${tableCode(file.path)} | ${formatNumber(file.commits)} | ${formatShare(file.share)} |`
    ),
    '',
    `## Production files of ${formatNumber(tree.largeProductionFiles.threshold)} lines or more: ${formatNumber(tree.largeProductionFiles.count)}`,
    '',
    ...tree.largeProductionFiles.files.map(
      (file) => `- ${code(file.path)}: ${formatNumber(file.lines)}`
    ),
    '',
    '## `vi.mock` calls',
    '',
    `${formatNumber(tree.viMocks.calls)} calls in ${formatNumber(tree.viMocks.filesWithMocks)} of ${formatNumber(tree.viMocks.testFiles)} test files under \`src/\`.`,
    '',
    '| Target | Calls |',
    '| --- | --- |',
    ...mockTargetClasses.map(
      (name) => `| ${name} | ${formatNumber(tree.viMocks.byTarget[name])} |`
    ),
    '',
    '## Baselines and exceptions',
    '',
    '| List | Entries |',
    '| --- | --- |',
    `| \`scripts/unused-code-baseline.json\` production | ${formatNumber(tree.baselines.unusedCodeProduction)} |`,
    `| \`scripts/unused-code-baseline.json\` exports | ${formatNumber(tree.baselines.unusedCodeExports)} |`,
    `| \`scripts/file-length-baseline.json\` | ${formatNumber(tree.baselines.fileLength)} |`,
    `| Lint rule exceptions (\`lint-rules/rules/*.exceptions.json\`) | ${formatNumber(tree.baselines.lintRuleExceptions)} |`,
    `| \`sessionModuleCycles\` | ${tree.sessionModuleCycles === null ? `n/a (no \`${sessionModulesPath}\`)` : formatNumber(tree.sessionModuleCycles)} |`,
    '',
  ];
  return lines.join('\n');
}
