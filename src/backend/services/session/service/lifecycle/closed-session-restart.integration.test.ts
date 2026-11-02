import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CodexRuntimeContext } from '@/backend/services/codex-accounts';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let service: typeof import('./closed-session-persistence.service').closedSessionPersistenceService;
let Domain: typeof import('../session-domain.service').SessionDomainService;
let Finalizer: typeof import('./session-workflow-finalizer').SessionWorkflowFinalizer;
let hydrator: typeof import('./session-provider-history-hydrator').createProviderHistoryHydrator;
let atomic: typeof import('@/backend/lib/atomic-file');
let config: typeof import('@/backend/services/config.service').configService;
let paths: typeof import('./closed-session-storage');
const sessionId = 'restart-session';
let worktree: string;
let providerFile: string;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ configService: config } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service'));
  ({ closedSessionPersistenceService: service } = await vi.importActual<
    typeof import('./closed-session-persistence.service')
  >('./closed-session-persistence.service'));
  ({ SessionDomainService: Domain } = await vi.importActual<
    typeof import('../session-domain.service')
  >('../session-domain.service'));
  ({ SessionWorkflowFinalizer: Finalizer } = await vi.importActual<
    typeof import('./session-workflow-finalizer')
  >('./session-workflow-finalizer'));
  ({ createProviderHistoryHydrator: hydrator } = await vi.importActual<
    typeof import('./session-provider-history-hydrator')
  >('./session-provider-history-hydrator'));
  atomic = await vi.importActual<typeof import('@/backend/lib/atomic-file')>(
    '@/backend/lib/atomic-file'
  );
  paths = await vi.importActual<typeof import('./closed-session-storage')>(
    './closed-session-storage'
  );
});

beforeEach(async () => {
  vi.spyOn(config, 'getBaseDir').mockReturnValue(db.tempDir);
  vi.spyOn(config, 'getClaudeConfigDir').mockReturnValue(join(db.tempDir, 'provider'));
  worktree = join(db.tempDir, 'worktree');
  providerFile = join(
    db.tempDir,
    'provider',
    'projects',
    worktree.replace(':', '').replace(/[\\/]/g, '-'),
    'history.jsonl'
  );
  await mkdir(dirname(providerFile), { recursive: true });
  await mkdir(worktree, { recursive: true });
  const project = await db.prisma.project.create({
    data: { name: 'restart', slug: 'restart', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', name: 'restart', projectId: project.id, worktreePath: worktree },
  });
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId: 'workspace',
      provider: 'CLAUDE',
      codexAccountId: null,
      providerSessionId: 'history',
      model: 'sonnet',
      workflow: 'ratchet',
      createdAt: new Date('2026-01-01'),
    },
  });
});
afterEach(async () => {
  await service.stopArchiveMaintenance();
  vi.restoreAllMocks();
  await clearIntegrationDatabase(db.prisma);
  await rm(join(db.tempDir, 'closed-sessions'), { recursive: true, force: true });
  await rm(join(db.tempDir, 'provider'), { recursive: true, force: true });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function runtime(failDeletion: boolean, context?: CodexRuntimeContext) {
  const domain = new Domain();
  const hydrate = hydrator(domain);
  const finalizer = new Finalizer({
    repository: {
      getSessionById: (id) => db.prisma.agentSession.findUnique({ where: { id } }),
      deleteSession: (id) => {
        if (failDeletion) {
          return Promise.reject(new Error('interrupted before active-session deletion'));
        }
        return db.prisma.agentSession.delete({ where: { id } });
      },
      recoverStaleRunningSessions: async () => 0,
    },
    workspaceLookup: { findById: async () => ({ worktreePath: worktree }) },
    sessionDomainService: domain,
    closedSessionPersistenceService: service,
    hydrateProviderHistory: (id, session) =>
      hydrate(id, { ...session, codexAccountContext: context }),
    lifecycleEventService: { hydrate: async () => undefined },
    runtimeManager: { isSessionRunning: () => false, hasObservedEmptyProviderSession: () => false },
    countViewers: () => 0,
  });
  return { domain, hydrate, finalizer };
}

async function close(finalizer: InstanceType<typeof Finalizer>) {
  const session = await db.prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
  await finalizer.finalizeDeliberateStop({
    session,
    sessionId,
    cleanupTransientRatchetSession: true,
  });
}
function historyEntry(uuid?: string) {
  return JSON.stringify({
    type: 'assistant',
    ...(uuid ? { uuid } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Saved provider answer' }] },
  });
}

it.each([
  { live: true, phase: 'pending' },
  { live: true, phase: 'complete' },
  { live: false, phase: 'pending' },
  { live: false, phase: 'complete' },
])(
  'reuses $phase bytes after restart with live=$live and timestamp-less provider history',
  async ({ live, phase }) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await writeFile(providerFile, `${historyEntry(live ? 'provider-message' : undefined)}\n`);
    const initial = runtime(true);
    if (live) {
      initial.domain.appendClaudeEvent(sessionId, {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        session_id: 'history',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Saved provider answer' }] },
      });
    }
    const write =
      phase === 'pending'
        ? vi
            .spyOn(atomic, 'writeFileAtomic')
            .mockRejectedValueOnce(new Error('interrupted before write'))
        : undefined;
    await close(initial.finalizer);
    write?.mockRestore();
    expect(await db.prisma.agentSession.count()).toBe(1);
    const original = await db.prisma.closedSession.findFirstOrThrow();
    const originalBytes =
      original.pendingTranscript ??
      (await readFile(paths.resolveClosedSessionTranscriptPath(original, null), 'utf8'));
    const before = initial.domain.getTranscriptSnapshot(sessionId)[0]!;
    initial.domain.clearAllSessions();
    vi.mocked(Date.now).mockReturnValue(1_800_000_060_000);
    const restarted = runtime(false);
    const session = await db.prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
    await restarted.hydrate(sessionId, { ...session, workspace: { worktreePath: worktree } });
    const after = restarted.domain.getTranscriptSnapshot(sessionId)[0]!;
    expect(after.id).not.toBe(before.id);
    expect(after.timestamp).not.toBe(before.timestamp);
    await service.recoverPending('workspace');
    await close(restarted.finalizer);
    expect(await db.prisma.agentSession.count()).toBe(0);
    const archives = await db.prisma.closedSession.findMany();
    expect(archives).toHaveLength(1);
    expect(archives[0]?.id).toBe(original.id);
    expect(
      await readFile(paths.resolveClosedSessionTranscriptPath(archives[0]!, null), 'utf8')
    ).toBe(originalBytes);
  }
);

it('keeps a genuinely later provider snapshot distinct after restart', async () => {
  await writeFile(providerFile, `${historyEntry('first')}\n`);
  await close(runtime(true).finalizer);
  await appendFile(providerFile, `${historyEntry('second')}\n`);
  await close(runtime(false).finalizer);
  expect(await db.prisma.closedSession.count()).toBe(2);
});

it('recovers a real atomic writer exit immediately before rename and removes its staging bytes', async () => {
  await writeFile(providerFile, `${historyEntry('first')}\n`);
  const execute = promisify(execFile);
  const crash = vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (path, bytes) => {
    const script = `const fs = require('node:fs/promises'); fs.rename = () => process.exit(0); require('node:module').syncBuiltinESMExports(); const { writeFileAtomic } = require(process.argv[1]); writeFileAtomic(process.argv[2], process.argv[3], { temporaryFileTag: 'archive-' + process.pid });`;
    await execute(process.execPath, [
      '-e',
      script,
      resolve('src/backend/lib/atomic-file.ts'),
      path,
      String(bytes),
    ]);
    throw new Error('writer exited before rename');
  });
  await close(runtime(true).finalizer);
  crash.mockRestore();
  const pending = await db.prisma.closedSession.findFirstOrThrow();
  const directory = paths.closedSessionWorkspaceDirectory('workspace');
  expect(await readdir(directory)).toEqual([expect.stringMatching(/^\.tmp-archive-/)]);
  await service.recoverPending('workspace');
  await service.maintainArchives();
  const complete = await db.prisma.closedSession.findUniqueOrThrow({ where: { id: pending.id } });
  expect(complete.archiveState).toBe('COMPLETE');
  expect(await readdir(directory)).toEqual([`${complete.id}.${complete.transcriptHash}.json`]);
  expect(await readFile(paths.resolveClosedSessionTranscriptPath(complete, null), 'utf8')).toBe(
    pending.pendingTranscript
  );
});

it.each(['pending', 'complete'])(
  'reuses %s native tool-result history with an explicit success flag',
  async (phase) => {
    const tool = { type: 'tool_use' as const, id: 'call', name: 'Read', input: { x: 1, y: 2 } };
    const output = { type: 'tool_result' as const, tool_use_id: 'call', content: 'saved output' };
    await writeFile(
      providerFile,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ ...tool, input: { y: 2, x: 1 } }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ ...output, is_error: false }] } })}\n`
    );
    const initial = runtime(true);
    initial.domain.appendClaudeEvent(sessionId, {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 7, content_block: tool },
    });
    initial.domain.appendClaudeEvent(sessionId, {
      type: 'user',
      message: { role: 'user', content: [output] },
    });
    const write =
      phase === 'pending'
        ? vi
            .spyOn(atomic, 'writeFileAtomic')
            .mockRejectedValueOnce(new Error('interrupted before write'))
        : undefined;
    await close(initial.finalizer);
    write?.mockRestore();
    const original = await db.prisma.closedSession.findFirstOrThrow();
    const bytes =
      original.pendingTranscript ??
      (await readFile(paths.resolveClosedSessionTranscriptPath(original, null), 'utf8'));
    initial.domain.clearAllSessions();
    await service.recoverPending('workspace');
    await close(runtime(false).finalizer);
    const archives = await db.prisma.closedSession.findMany();
    expect(archives).toHaveLength(1);
    expect(archives[0]?.id).toBe(original.id);
    expect(
      await readFile(paths.resolveClosedSessionTranscriptPath(archives[0]!, null), 'utf8')
    ).toBe(bytes);
  }
);

it.each(['pending', 'complete'])(
  'reuses %s timestamp-less Codex history after restart',
  async (phase) => {
    await db.prisma.agentSession.update({
      where: { id: sessionId },
      data: { provider: 'CODEX', codexAccountId: 'codex-native-default' },
    });
    const home = join(db.tempDir, 'provider', 'codex');
    const sessionsDir = join(home, 'sessions');
    const file = join(sessionsDir, '2026', '11', '02', 'rollout-history.jsonl');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'history', cwd: worktree } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Saved provider answer' } })}\n`
    );
    const context = {
      accountId: 'codex-native-default',
      homeDir: home,
      sessionsDir,
      env: { CODEX_HOME: home },
    };
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const initial = runtime(true, context);
    const write =
      phase === 'pending'
        ? vi
            .spyOn(atomic, 'writeFileAtomic')
            .mockRejectedValueOnce(new Error('interrupted before write'))
        : undefined;
    await close(initial.finalizer);
    write?.mockRestore();
    const original = await db.prisma.closedSession.findFirstOrThrow();
    const bytes =
      original.pendingTranscript ??
      (await readFile(paths.resolveClosedSessionTranscriptPath(original, null), 'utf8'));
    const firstId = initial.domain.getTranscriptSnapshot(sessionId)[0]!.id;
    initial.domain.clearAllSessions();
    vi.mocked(Date.now).mockReturnValue(1_800_000_060_000);
    const restarted = runtime(false, context);
    const session = await db.prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
    await restarted.hydrate(sessionId, {
      ...session,
      codexAccountContext: context,
      workspace: { worktreePath: worktree },
    });
    expect(restarted.domain.getTranscriptSnapshot(sessionId)[0]!.id).not.toBe(firstId);
    await service.recoverPending('workspace');
    await close(restarted.finalizer);
    const archives = await db.prisma.closedSession.findMany();
    expect(archives).toHaveLength(1);
    expect(archives[0]?.id).toBe(original.id);
    expect(
      await readFile(paths.resolveClosedSessionTranscriptPath(archives[0]!, null), 'utf8')
    ).toBe(bytes);
  }
);
