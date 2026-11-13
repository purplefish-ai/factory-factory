import { sessionModulesPath } from './baselines';
import type { AgentMetrics } from './collect';
import type { Distribution, TimeWindow } from './statistics';
import { mockTargetClasses } from './vi-mocks';

function formatNumber(value: number | null, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toLocaleString('en-US')}${suffix}`;
}

function formatShare(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDistribution(value: Distribution, unit: string): string {
  return `median ${formatNumber(value.median, unit)}, p90 ${formatNumber(value.p90, unit)} (n=${value.count})`;
}

function formatWindow(window: TimeWindow): string {
  return `${window.from ?? 'n/a'} to ${window.to ?? 'n/a'}`;
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
    `CI: ${ci.runs} \`pull_request\` runs of \`ci.yml\` (${ci.attempts} attempts), started ${formatWindow(ci.window)}.`,
    `Pull requests: ${pullRequests.merged} merged, ${formatWindow(pullRequests.window)}.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| PR branches green on first non-cancelled run | ${ci.firstRun.greenOnFirstRun} of ${ci.firstRun.decided} (${formatShare(ci.firstRun.greenShare)}) |`,
    `| PR branches with any failed run | ${ci.firstRun.branchesWithFailure} of ${ci.firstRun.branches} |`,
    `| Pushes per PR branch | ${formatDistribution(ci.pushesPerBranch, '')} |`,
    `| CI duration, successful runs | ${formatDistribution(ci.successfulDurationMinutes, ' min')} |`,
    `| Commits that failed then passed | ${ci.failedThenPassedCommits} |`,
    `| Open to merge | ${formatDistribution(pullRequests.openToMergeHours, ' h')} |`,
    `| Merged PRs titled with a fix verb | ${pullRequests.followUpFixes.fixTitled} of ${pullRequests.merged} |`,
    `| Fix PRs referencing a PR merged in the previous 7 days | ${pullRequests.followUpFixes.referencingRecentMerge} (${formatShare(pullRequests.followUpFixes.share)})${pullRequests.followUpFixes.numbers.length > 0 ? `: ${pullRequests.followUpFixes.numbers.map((number) => `#${number}`).join(', ')}` : ''} |`,
    '',
    '## Guidance',
    '',
    '| Directory | Guide chain | Lines | Estimated tokens |',
    '| --- | --- | --- | --- |',
    ...tree.guideChains.map(
      (chain) =>
        `| \`${chain.directory}\` | ${chain.guides.map((guide) => `\`${guide}\``).join(' → ')} | ${formatNumber(chain.lines)} | ${formatNumber(chain.tokens)} |`
    ),
    '',
    `Guidance: ${formatNumber(tree.guidance.guidanceLines)} lines (\`AGENTS.md\` ${formatNumber(tree.guidance.guideLines)}, \`docs/architecture\` ${formatNumber(tree.guidance.architectureNoteLines)}) against ${formatNumber(tree.guidance.sourceLines)} production source lines under \`src/\`: ${formatNumber(tree.guidance.guidancePerThousandSourceLines)} per 1,000.`,
    '',
    `## Most-edited files (last ${tree.mostEditedFiles.commits} commits)`,
    '',
    '| File | Commits | Share |',
    '| --- | --- | --- |',
    ...tree.mostEditedFiles.files.map(
      (file) => `| \`${file.path}\` | ${file.commits} | ${formatShare(file.share)} |`
    ),
    '',
    `## Production files of ${tree.largeProductionFiles.threshold} lines or more: ${tree.largeProductionFiles.count}`,
    '',
    ...tree.largeProductionFiles.files.map(
      (file) => `- \`${file.path}\`: ${formatNumber(file.lines)}`
    ),
    '',
    '## `vi.mock` calls',
    '',
    `${formatNumber(tree.viMocks.calls)} calls in ${formatNumber(tree.viMocks.filesWithMocks)} of ${formatNumber(tree.viMocks.testFiles)} test files under \`src/\`.`,
    '',
    '| Target | Calls |',
    '| --- | --- |',
    ...mockTargetClasses.map((name) => `| ${name} | ${tree.viMocks.byTarget[name]} |`),
    '',
    '## Baselines and exceptions',
    '',
    '| List | Entries |',
    '| --- | --- |',
    `| \`scripts/unused-code-baseline.json\` production | ${tree.baselines.unusedCodeProduction} |`,
    `| \`scripts/unused-code-baseline.json\` exports | ${tree.baselines.unusedCodeExports} |`,
    `| \`scripts/file-length-baseline.json\` | ${tree.baselines.fileLength} |`,
    `| \`.oxlintrc.json\` rule exceptions | ${tree.baselines.lintExceptions} |`,
    `| \`sessionModuleCycles\` | ${tree.sessionModuleCycles === null ? `n/a (no \`${sessionModulesPath}\`)` : tree.sessionModuleCycles} |`,
    '',
  ];
  return lines.join('\n');
}
