import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFileLink } from './workspace-file-links';

const WORKTREE = '/Users/martin/factory-factory/worktrees/factory-factory/workspace-demo';
const ORIGIN = 'http://localhost:3000';

describe('resolveWorkspaceFileLink', () => {
  it('resolves an absolute workspace path with a line suffix', () => {
    expect(
      resolveWorkspaceFileLink(`${WORKTREE}/.planning/codebase/CONCERNS.md:31`, WORKTREE, ORIGIN)
    ).toBe('.planning/codebase/CONCERNS.md');
  });

  it('resolves a same-origin URL that wraps an absolute workspace path', () => {
    expect(
      resolveWorkspaceFileLink(
        `${ORIGIN}${WORKTREE}/src/client/App%20Shell.md:12:4`,
        WORKTREE,
        ORIGIN
      )
    ).toBe('src/client/App Shell.md');
  });

  it('rejects paths outside the workspace', () => {
    expect(
      resolveWorkspaceFileLink('/Users/martin/factory-factory/other/README.md:3', WORKTREE, ORIGIN)
    ).toBeNull();
  });

  it('rejects decoded path traversal outside the workspace', () => {
    expect(
      resolveWorkspaceFileLink(`${ORIGIN}${WORKTREE}/src/%2e%2e/%2e%2e/README.md`, WORKTREE, ORIGIN)
    ).toBeNull();
  });

  it('rejects normal external URLs', () => {
    expect(
      resolveWorkspaceFileLink('https://github.com/example/repo', WORKTREE, ORIGIN)
    ).toBeNull();
  });

  it('rejects same-origin app routes that are not workspace files', () => {
    expect(
      resolveWorkspaceFileLink(
        `${ORIGIN}/projects/factory-factory/workspaces/workspace-demo`,
        WORKTREE,
        ORIGIN
      )
    ).toBeNull();
  });
});
