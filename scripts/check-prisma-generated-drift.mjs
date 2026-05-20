#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const generatedPath = 'prisma/generated';

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const unstagedFiles = runGit(['diff', '--name-only', '--', generatedPath]);
const stagedFiles = runGit(['diff', '--cached', '--name-only', '--', generatedPath]);
const untrackedFiles = runGit(['ls-files', '--others', '--', generatedPath]);
const driftedFiles = Array.from(new Set([...unstagedFiles, ...stagedFiles, ...untrackedFiles]));

if (driftedFiles.length > 0) {
  process.stderr.write(
    [
      'Generated Prisma client is out of sync.',
      'Run `pnpm db:generate` and commit the generated changes under prisma/generated/.',
      '',
      ...driftedFiles.map((file) => `- ${file}`),
      '',
    ].join('\n')
  );
  process.exit(1);
}

process.stdout.write('Generated Prisma client is in sync.\n');
