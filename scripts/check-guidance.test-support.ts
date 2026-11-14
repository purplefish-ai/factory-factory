import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readGuidanceRepository } from './check-guidance';

const temporaryDirectories: string[] = [];

/** Removes the repositories the test created; call it from `afterEach`. */
export function removeTemporaryRepositories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function git(repositoryRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

export function writeFiles(repositoryRoot: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repositoryRoot, path)), { recursive: true });
    writeFileSync(join(repositoryRoot, path), content);
  }
}

export function createRepository(files: Record<string, string>): string {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'guidance-check-'));
  temporaryDirectories.push(repositoryRoot);
  git(repositoryRoot, 'init', '--quiet', '--initial-branch=main');
  git(repositoryRoot, 'config', 'user.email', 'test@example.com');
  git(repositoryRoot, 'config', 'user.name', 'Guidance Check Test');
  git(repositoryRoot, 'config', 'commit.gpgsign', 'false');
  writeFiles(repositoryRoot, files);
  return repositoryRoot;
}

export function repositoryWith(files: Record<string, string>) {
  return readGuidanceRepository(createRepository(files));
}

export function lines(count: number): string {
  return 'line\n'.repeat(count);
}
