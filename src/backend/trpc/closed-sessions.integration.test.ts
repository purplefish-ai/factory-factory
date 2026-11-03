import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let router: typeof import('./closed-sessions.trpc').closedSessionsRouter;
let service: ReturnType<typeof import('@/backend/services/session').createSessionDataService>;
let root: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  // The helper clears BASE_DIR; isolate it again before importing application modules.
  process.env.BASE_DIR = join(db.tempDir, 'application');
  mkdirSync(process.env.BASE_DIR, { recursive: true });
  ({ closedSessionsRouter: router } =
    await vi.importActual<typeof import('./closed-sessions.trpc')>('./closed-sessions.trpc'));
  const { createSessionDataService } = await vi.importActual<
    typeof import('@/backend/services/session')
  >('@/backend/services/session');
  service = createSessionDataService({
    providerResolver: {
      resolveSessionDefaults: () => {
        throw new Error('Closed reads must not resolve a provider');
      },
    },
  });
  root = join(db.tempDir, 'actual-fk-worktree');
  mkdirSync(join(root, 'legacy/subdirectory'), { recursive: true });
  const project = await db.prisma.project.create({
    data: {
      name: 'Archive',
      slug: 'archive',
      repoPath: '/unused-repo',
      worktreeBasePath: '/unused-worktrees',
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: project.id, name: 'Archived workspace', worktreePath: root },
  });
  workspaceId = workspace.id;
  await db.prisma.closedSession.create({
    data: {
      id: 'closed-real',
      workspaceId,
      sessionId: 'original',
      workflow: 'ratchet',
      provider: 'CLAUDE',
      model: 'model',
      transcriptPath: 'legacy/subdirectory/archive.json',
      startedAt: new Date(),
    },
  });
}, 30_000);

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function caller() {
  return router.createCaller({
    appContext: { services: { sessionDataService: service } },
  } as never);
}

it('composes real router, facade, owner, migrated DB FK and filesystem for a legacy DTO', async () => {
  const legacy = { messages: [{ role: 'user', content: 'hello' }], sessionSummary: 'Test summary' };
  writeFileSync(join(root, 'legacy/subdirectory/archive.json'), JSON.stringify(legacy));
  await expect(caller().getTranscript({ id: 'closed-real' })).resolves.toEqual(legacy);
});

it('preserves reserved keys and current extras through the complete API composition', async () => {
  const encoded =
    '{"__proto__":{"envelope":1},"metadata":null,"version":["future"],"messages":[{"id":"rich","source":"user","text":"visible","timestamp":"","order":0,"extra":{"__proto__":{"nested":1}}}]}';
  writeFileSync(join(root, 'legacy/subdirectory/archive.json'), encoded);
  const transcript = await caller().getTranscript({ id: 'closed-real' });
  expect(JSON.stringify(transcript)).toBe(encoded);
  expect(Object.hasOwn(transcript, '__proto__')).toBe(true);
});

it.each(['not json', 'null', '[]', '{}', '{"messages":false}'])(
  'maps invalid full body %s to a safe tRPC error',
  async (body) => {
    writeFileSync(join(root, 'legacy/subdirectory/archive.json'), body);
    await expect(caller().getTranscript({ id: 'closed-real' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to read transcript file',
    });
  }
);

it('uses the FK root rather than an envelope path or another workspace', async () => {
  writeFileSync(
    join(root, 'legacy/subdirectory/archive.json'),
    JSON.stringify({ workspaceId: 'untrusted', workingDir: '/untrusted', messages: [null] })
  );
  await expect(caller().getTranscript({ id: 'closed-real' })).resolves.toMatchObject({
    messages: [null],
  });
  await db.prisma.closedSession.update({
    where: { id: 'closed-real' },
    data: { transcriptPath: '../outside.json' },
  });
  await expect(caller().getTranscript({ id: 'closed-real' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'Invalid closed session transcript path',
  });
  await db.prisma.closedSession.update({
    where: { id: 'closed-real' },
    data: { transcriptPath: 'missing.json' },
  });
  await expect(caller().getTranscript({ id: 'closed-real' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'Transcript file not found',
  });
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { worktreePath: null } });
  await expect(caller().getTranscript({ id: 'closed-real' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'Workspace has no worktree path',
  });
  await expect(caller().getTranscript({ id: 'missing-row' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'Closed session not found',
  });
});
