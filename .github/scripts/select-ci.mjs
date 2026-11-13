import { execFileSync } from 'node:child_process';

// Only explicit prose paths and backend TypeScript may omit browser work.
// Unknown paths (including dependencies, shared code, styles and config) run all.
// The sandbox smoke test drives the whole application, its launcher and the
// scripted provider, so it runs whenever application work does.
export function selectJobs(event, files) {
  if (event !== 'pull_request' || files.length === 0) {
    return { app: true, storybook: true, sandbox: true };
  }
  const isDocumentation = (file) =>
    /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/.test(file) ||
    (/^docs\/.+\.md$/.test(file) && !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file));
  const isBackend = (file) => /^src\/backend\/.+\.(?:ts|tsx)$/.test(file);
  const app = !files.every(isDocumentation);
  return {
    app,
    storybook: !files.every((file) => isDocumentation(file) || isBackend(file)),
    sandbox: app,
  };
}

if (import.meta.main) {
  const [event] = process.argv.slice(2);
  let files = [];
  if (event === 'pull_request') {
    // GitHub may regenerate the merge against newer main than the event base SHA.
    // Verify a merge checkout before diffing its actual first parent; a PR head
    // checkout must never be mistaken for the integrated PR change set.
    execFileSync('git', ['rev-parse', '--verify', 'HEAD^2'], { stdio: 'pipe' });
    // --no-renames includes both sides of moves; NUL delimiters handle any name.
    files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', 'HEAD^1', 'HEAD'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
  }
  const selected = selectJobs(event, files);
  for (const [job, enabled] of Object.entries(selected)) {
    process.stdout.write(`${job}=${enabled}\n`);
  }
}
