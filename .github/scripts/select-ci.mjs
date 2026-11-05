import { execFileSync } from 'node:child_process';

// Only explicit prose paths and backend TypeScript may omit browser work.
// Unknown paths (including dependencies, shared code, styles and config) run all.
export function selectJobs(event, files) {
  if (event !== 'pull_request' || files.length === 0) {
    return { app: true, storybook: true };
  }
  const isDocumentation = (file) =>
    /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/.test(file) ||
    (/^docs\/.+\.md$/.test(file) && !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file));
  const isBackend = (file) => /^src\/backend\/.+\.(?:ts|tsx)$/.test(file);
  return {
    app: !files.every(isDocumentation),
    storybook: !files.every((file) => isDocumentation(file) || isBackend(file)),
  };
}

if (import.meta.main) {
  const [event, base] = process.argv.slice(2);
  // Checkout uses the PR merge commit, so diffing its first parent/base includes
  // the integrated PR changes without fetching repository history or an API.
  // --no-renames includes both sides of moves; NUL delimiters handle any name.
  const files =
    event === 'pull_request'
      ? execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], {
          encoding: 'utf8',
        })
          .split('\0')
          .filter(Boolean)
      : [];
  const selected = selectJobs(event, files);
  for (const [job, enabled] of Object.entries(selected)) {
    process.stdout.write(`${job}=${enabled}\n`);
  }
}
