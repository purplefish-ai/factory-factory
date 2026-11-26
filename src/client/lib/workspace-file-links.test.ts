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

  it('resolves a file URL against a Windows worktree path', () => {
    expect(
      resolveWorkspaceFileLink(
        'file:///C:/Users/martin/factory-factory/workspace-demo/src/client/App%20Shell.md',
        String.raw`C:\Users\martin\factory-factory\workspace-demo`,
        ORIGIN
      )
    ).toBe('src/client/App Shell.md');
  });

  it('compares Windows workspace paths case-insensitively', () => {
    expect(
      resolveWorkspaceFileLink(
        'file:///c:/users/MARTIN/factory-factory/workspace-demo/src/client/App%20Shell.md',
        String.raw`C:\Users\martin\factory-factory\workspace-demo`,
        ORIGIN
      )
    ).toBe('src/client/App Shell.md');
  });

  it.each([
    ['forward slashes', 'C:/Users/martin/factory-factory/workspace-demo/src/app.ts:12'],
    ['backslashes', String.raw`C:\Users\martin\factory-factory\workspace-demo\src\app.ts:12`],
    [
      'percent-encoded backslashes',
      'C:%5CUsers%5Cmartin%5Cfactory-factory%5Cworkspace-demo%5Csrc%5Capp.ts:12',
    ],
  ])('resolves a bare Windows absolute path with %s', (_label, href) => {
    expect(
      resolveWorkspaceFileLink(
        href,
        String.raw`C:\Users\martin\factory-factory\workspace-demo`,
        ORIGIN
      )
    ).toBe('src/app.ts');
  });

  it('drops the fragment from a bare Windows absolute path', () => {
    expect(
      resolveWorkspaceFileLink(
        'C:/Users/martin/factory-factory/workspace-demo/src/app.ts#L12',
        String.raw`C:\Users\martin\factory-factory\workspace-demo`,
        ORIGIN
      )
    ).toBe('src/app.ts');
  });

  it('preserves backslashes as literal characters in POSIX paths', () => {
    expect(
      resolveWorkspaceFileLink(
        'file:///repo/work/tree/src/client/App%20Shell.md',
        String.raw`/repo/work\tree`,
        ORIGIN
      )
    ).toBeNull();
  });

  it('rejects paths outside the workspace', () => {
    expect(
      resolveWorkspaceFileLink('/Users/martin/factory-factory/other/README.md:3', WORKTREE, ORIGIN)
    ).toBeNull();
  });

  it.each([
    ['/tmp/build%20log.txt:12:4', '/tmp/build log.txt'],
    ['file:///tmp/screenshot.png', '/tmp/screenshot.png'],
    ['/private/tmp/screenshot.png', '/private/tmp/screenshot.png'],
  ])('opens a host temporary file link %s', (href, filePath) => {
    expect(resolveWorkspaceFileLink(href, WORKTREE, ORIGIN)).toBe(filePath);
  });

  it('recognizes temporary files even when the workspace has no worktree', () => {
    expect(resolveWorkspaceFileLink('/tmp/build.log', null, ORIGIN)).toBe('/tmp/build.log');
  });

  it.each([
    '/tmp/../etc/hosts',
    '/tmp/%2e%2e%2fetc/hosts',
    '/tmp-other/build.log',
    'https://example.com/tmp/build.log',
    '//example.com/tmp/build.log',
    'file://example.com/tmp/build.log',
    'tmp/build.log',
  ])('does not treat %s as a host temporary file', (href) => {
    expect(resolveWorkspaceFileLink(href, WORKTREE, ORIGIN)).toBeNull();
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
