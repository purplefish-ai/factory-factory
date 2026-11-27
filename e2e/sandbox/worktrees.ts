import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { Sandbox } from './sandbox';

// What a user sees of a workspace's Git worktree from outside the application: the directory on
// disk and what `git worktree list` and `git branch` say in the project's repository.

/** The id of the workspace the page has open (the last part of its `/workspaces/<id>` address). */
export function openWorkspaceId(page: Page) {
  const id = /\/workspaces\/([^/?#]+)/.exec(new URL(page.url()).pathname)?.[1] ?? '';
  expect(id, `a workspace id in ${page.url()}`).not.toBe('');
  return id;
}

function git(sandbox: Sandbox, ...args: string[]) {
  return execFileSync('git', ['-C', sandbox.repoPath, ...args], { encoding: 'utf8' });
}

/** The worktree Git lists for workspace `workspaceId` (its directory is named after the id). */
export function worktreeOf(sandbox: Sandbox, workspaceId: string) {
  const entries = git(sandbox, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '',
    }))
    .filter((entry) => entry.path.endsWith(workspaceId));
  expect(entries, `one worktree for workspace ${workspaceId}`).toHaveLength(1);
  const [entry = { path: '', branch: '' }] = entries;
  expect(existsSync(entry.path), `the worktree directory ${entry.path} exists`).toBe(true);
  expect(entry.branch, `the branch checked out in ${entry.path}`).not.toBe('');
  return entry;
}

/** Whether `git worktree list` still names the directory `path`. */
export function gitListsWorktree(sandbox: Sandbox, path: string) {
  return git(sandbox, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);
}

/** Whether the repository still has a branch named `branch`. */
export function branchExists(sandbox: Sandbox, branch: string) {
  return git(sandbox, 'branch', '--list', branch).trim() !== '';
}
