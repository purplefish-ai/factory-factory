import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('@/backend/services/session/resources/closed-session.accessor', () => ({
  closedSessionAccessor: { findByIdWithWorkspace: mocks.find },
}));

import { readClosedSessionProviderIdentity } from './closed-session-reader';

let dir: string;
let root: string;
const header = {
  version: 1,
  sessionId: 'main',
  workspaceId: 'workspace-1',
  metadata: { provider: 'CODEX', providerSessionId: 'provider-1', codexAccountId: 'account-1' },
};

function row(transcriptPath = 'transcripts/main.json', worktreePath: string | null = root) {
  return {
    id: 'closed-1',
    sessionId: 'main',
    workspaceId: 'workspace-1',
    provider: 'CODEX',
    transcriptPath,
    workspace: { id: 'workspace-1', worktreePath },
  };
}

function write(value: unknown = { ...header, messages: [] }) {
  writeFileSync(join(root, 'transcripts/main.json'), JSON.stringify(value, null, 2));
}

beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'ff-archive-reader-'));
  root = join(dir, 'repo');
  mkdirSync(join(root, 'transcripts'), { recursive: true });
  mocks.find.mockResolvedValue(row());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readClosedSessionProviderIdentity', () => {
  it('reads a legacy relative path and preserves the worktree spelling for history lookup', async () => {
    write();
    const linkedRoot = join(dir, 'linked-repo');
    symlinkSync(root, linkedRoot);
    mocks.find.mockResolvedValue(row('transcripts/../transcripts/main.json', linkedRoot));
    await expect(readClosedSessionProviderIdentity('closed-1')).resolves.toEqual({
      ...header.metadata,
      workingDir: linkedRoot,
    });
    expect(mocks.find).toHaveBeenCalledExactlyOnceWith('closed-1');
  });

  it('uses the pretty header even when its large body is truncated', async () => {
    const pretty = JSON.stringify(
      { ...header, messages: [{ text: 'x'.repeat(200_000) }] },
      null,
      2
    );
    writeFileSync(join(root, 'transcripts/main.json'), pretty.slice(0, 100_000));
    await expect(readClosedSessionProviderIdentity('closed-1')).resolves.toMatchObject(
      header.metadata
    );
  });

  it.each(['compact', 'reordered'] as const)('retains the complete %s fallback', async (format) => {
    const { metadata, ...rest } = header;
    const value =
      format === 'compact' ? { ...header, messages: [] } : { ...rest, messages: [], metadata };
    writeFileSync(
      join(root, 'transcripts/main.json'),
      JSON.stringify(value, null, format === 'compact' ? 0 : 2)
    );
    await expect(readClosedSessionProviderIdentity('closed-1')).resolves.toMatchObject(metadata);
  });

  it.each([
    '../outside.json',
    'transcripts/../../outside.json',
    '../repo-other/main.json',
    '/tmp/absolute.json',
    'C:\\archive\\main.json',
    'C:/archive/main.json',
    '\\\\server\\share\\main.json',
    '\\rooted\\main.json',
  ])('rejects unsafe stored path %s', async (path) => {
    writeFileSync(join(dir, 'outside.json'), JSON.stringify({ ...header, messages: [] }));
    mocks.find.mockResolvedValue(row(path));
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Invalid closed session transcript path',
    });
  });

  it.each(['file', 'directory'] as const)(
    'rejects a %s symlink outside the FK root',
    async (kind) => {
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'main.json'), JSON.stringify({ ...header, messages: [] }));
      if (kind === 'file') {
        symlinkSync(join(outside, 'main.json'), join(root, 'linked.json'));
        mocks.find.mockResolvedValue(row('linked.json'));
      } else {
        symlinkSync(outside, join(root, 'linked'));
        mocks.find.mockResolvedValue(row('linked/main.json'));
      }
      await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
  );

  it.each([
    { ...header, sessionId: 'another-session' },
    { ...header, workspaceId: 'another-workspace' },
    { ...header, metadata: { ...header.metadata, provider: 'CLAUDE' } },
    { ...header, metadata: { provider: 'CODEX' } },
    { ...header, metadata: { provider: 'CODEX', providerSessionId: '' } },
    { ...header, metadata: { ...header.metadata, codexAccountId: 42 } },
    { ...header, metadata: { ...header.metadata, codexAccountId: '' } },
    { messages: [] },
  ])('rejects unbound or invalid identity %#', async (identity) => {
    write({ ...identity, messages: [] });
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it.each([undefined, null, 'account-1'])(
    'preserves unknown versus known account %s',
    async (codexAccountId) => {
      const { workspaceId: _workspaceId, ...legacy } = header;
      write({ ...legacy, metadata: { ...header.metadata, codexAccountId }, messages: [] });
      const identity = await readClosedSessionProviderIdentity('closed-1');
      expect(identity.codexAccountId).toBe(codexAccountId);
    }
  );

  it('reports missing rows, worktrees and files with stable application errors', async () => {
    mocks.find.mockResolvedValue(null);
    await expect(readClosedSessionProviderIdentity('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Closed session not found',
    });
    mocks.find.mockResolvedValue(row('transcripts/main.json', null));
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Workspace has no worktree path',
    });
    mocks.find.mockResolvedValue(row());
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Transcript file not found',
    });
  });

  it('reports malformed headers and IO failures without leaking paths', async () => {
    writeFileSync(join(root, 'transcripts/main.json'), 'not json');
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Failed to read transcript file',
    });
    mocks.find.mockResolvedValue(row('transcripts'));
    await expect(readClosedSessionProviderIdentity('closed-1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Failed to read transcript file',
    });
  });
});
