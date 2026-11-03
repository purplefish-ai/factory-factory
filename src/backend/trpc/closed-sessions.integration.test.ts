import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createTRPCClient, httpBatchStreamLink, type TRPCClient } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { parseClosedSessionReadTranscript } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';

let db: IntegrationDatabase;
let router: typeof import('./closed-sessions.trpc').closedSessionsRouter;
let service: ReturnType<typeof import('@/backend/services/session').createSessionDataService>;
let root: string;
let workspaceId: string;
let server: Server;
let client: TRPCClient<typeof router>;

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
  const app = express();
  app.use('/api/trpc', createExpressMiddleware({ router, createContext: () => context() }));
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server');
  }
  client = createTRPCClient<typeof router>({
    links: [
      httpBatchStreamLink({
        url: `http://127.0.0.1:${address.port}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });
}, 30_000);

beforeEach(async () => {
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { worktreePath: root } });
  await db.prisma.closedSession.update({
    where: { id: 'closed-real' },
    data: { transcriptPath: 'legacy/subdirectory/archive.json' },
  });
});

afterAll(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

function context() {
  return { appContext: { services: { sessionDataService: service } } } as never;
}
function caller() {
  return router.createCaller(context());
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

function reservedWire(revision: number) {
  return `{"__proto__":{"archiveSentinel":"envelope-${revision}"},"constructor":{"keep":true},"prototype":[${revision}],"revision":${revision},"metadata":{"__proto__":{"archiveSentinel":"metadata-${revision}"},"changed":${revision}},"messages":[{"type":"future","__proto__":{"archiveSentinel":"message-${revision}"},"constructor":${revision},"prototype":false,"changed":${revision},"children":[{"__proto__":{"archiveSentinel":"child-${revision}"}}],"tool":{"input":{"__proto__":{"archiveSentinel":"tool-${revision}"}}}}]}`;
}

function assertOrdinaryReservedJson(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype
  );
  const ownsReserved = Object.hasOwn(value, '__proto__');
  if (ownsReserved) {
    expect('archiveSentinel' in value).toBe(false);
  }
  return (
    Number(ownsReserved) +
    Object.values(value).reduce<number>(
      (count, child) => count + assertOrdinaryReservedJson(child),
      0
    )
  );
}

it('preserves all JSON through actual SuperJSON HTTP and the same observer after a changed-file refetch', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = createTRPCQueryUtils({ client, queryClient });
  const observer = new QueryObserver(
    queryClient,
    utils.getTranscriptJson.queryOptions(
      { id: 'closed-real' },
      { select: parseClosedSessionReadTranscript, structuralSharing: false, retry: false }
    )
  );
  try {
    let previous: unknown;
    for (const revision of [1, 2]) {
      const encoded = reservedWire(revision);
      const expected: unknown = JSON.parse(encoded);
      writeFileSync(join(root, 'legacy/subdirectory/archive.json'), encoded);
      await expect(client.getTranscriptJson.query({ id: 'closed-real' })).resolves.toBe(encoded);
      const selected = await observer.refetch({ throwOnError: true });
      expect(JSON.stringify(selected.data)).toBe(encoded);
      expect(assertOrdinaryReservedJson(selected.data)).toBe(5);
      expect(selected.data).toEqual(expected);
      expect(Reflect.has(Object.prototype, 'archiveSentinel')).toBe(false);
      expect(selected.data).not.toBe(previous);
      previous = selected.data;
    }
  } finally {
    observer.destroy();
    queryClient.clear();
  }
});

it.each([
  { messages: [{ role: 'user', content: 'hello' }], sessionSummary: 'legacy' },
  {
    metadata: null,
    version: ['future'],
    sessionSummary: { x: 1 },
    messages: [null, 3, ['legacy']],
  },
  {
    messages: [
      {
        id: 'rich',
        source: 'user',
        text: 'visible',
        timestamp: '',
        order: 0,
        extension: { kept: true },
      },
    ],
  },
])(
  'keeps ordinary object API compatibility and always-string new HTTP output %#',
  async (value) => {
    const encoded = JSON.stringify(value);
    writeFileSync(join(root, 'legacy/subdirectory/archive.json'), encoded);
    await expect(client.getTranscript.query({ id: 'closed-real' })).resolves.toEqual(value);
    const wire = await client.getTranscriptJson.query({ id: 'closed-real' });
    expect(typeof wire).toBe('string');
    expect(wire).toBe(encoded);
    expect(parseClosedSessionReadTranscript(wire)).toEqual(value);
  }
);

it.each(['not JSON', 'null', '[]', '{}', '{"messages":false}'])(
  'keeps real HTTP owner errors for invalid full file %s',
  async (body) => {
    writeFileSync(join(root, 'legacy/subdirectory/archive.json'), body);
    await expect(client.getTranscriptJson.query({ id: 'closed-real' })).rejects.toMatchObject({
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Failed to read transcript file',
    });
  }
);

it('keeps safe missing/path status codes through the real HTTP JSON-text endpoint', async () => {
  await expect(client.getTranscriptJson.query({ id: 'missing-row' })).rejects.toMatchObject({
    data: { code: 'NOT_FOUND' },
    message: 'Closed session not found',
  });
  await db.prisma.closedSession.update({
    where: { id: 'closed-real' },
    data: { transcriptPath: '../outside.json' },
  });
  await expect(client.getTranscriptJson.query({ id: 'closed-real' })).rejects.toMatchObject({
    data: { code: 'BAD_REQUEST' },
    message: 'Invalid closed session transcript path',
  });
});
