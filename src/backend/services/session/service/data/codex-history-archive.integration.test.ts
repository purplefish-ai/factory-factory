import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let runtime: Awaited<ReturnType<typeof loadRuntime>>;
const timestamp = '2026-11-02T12:00:00.000Z';
const sessionId = 'split-native';
const event = (text: string, turn?: string) => ({
  type: 'event_msg',
  timestamp,
  payload: { type: 'user_message', message: text, turn_id: turn },
});
const response = (content: unknown[], turn?: string) => ({
  type: 'response_item',
  timestamp,
  payload: { type: 'message', role: 'user', content, turn_id: turn },
});
const text = (value: string) => ({ type: 'input_text', text: value });
const image = (data: string) => ({
  type: 'input_image',
  image_url: `data:image/png;base64,${data}`,
});
async function loadRuntime() {
  const { configService } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service');
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  const { closedSessionPersistenceService: archive } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-persistence.service')
  >('@/backend/services/session/service/lifecycle/closed-session-persistence.service');
  const { codexSessionHistoryLoaderService: loader } = await vi.importActual<
    typeof import('./codex-session-history-loader.service')
  >('./codex-session-history-loader.service');
  const { buildTranscriptFromHistory: build } = await vi.importActual<
    typeof import('@/backend/services/session/service/store/session-transcript')
  >('@/backend/services/session/service/store/session-transcript');
  const { resolveClosedSessionTranscriptPath: resolve } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  return { archive, loader, build, resolve };
}
async function load(entries: unknown[]) {
  const path = join(db.tempDir, 'sessions', '2026', '11', '02', `rollout-${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [{ type: 'session_meta', payload: { id: sessionId, cwd: '/work' } }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join('\n')
  );
  const result = await runtime.loader.loadSessionHistory({
    providerSessionId: sessionId,
    workingDir: '/work',
  });
  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') {
    throw new Error('Expected native history');
  }
  return result.history;
}
async function persist(entries: unknown[]) {
  const messages = runtime.build(await load(entries));
  await runtime.archive.persistClosedSession({
    sessionId,
    workspaceId: 'workspace',
    worktreePath: '/work',
    provider: 'CODEX',
    providerSessionId: sessionId,
    codexAccountId: 'account',
    conversationEpoch: 2,
    startedAt: new Date(0),
    name: null,
    workflow: 'followup',
    model: 'model',
    messages,
  });
  return messages;
}
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  vi.stubEnv('CODEX_HOME', db.tempDir);
  vi.stubEnv('CODEX_SESSIONS_DIR', undefined);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'P',
      slug: 'p',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  await db.prisma.workspace.create({ data: { id: 'workspace', projectId: 'project', name: 'W' } });
  runtime = await loadRuntime();
});
afterEach(async () => {
  await runtime.archive.stopArchiveMaintenance();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('keys every matched split image and reuses exact source bytes after module restart', async () => {
  const entries = (data: string) => [
    event('first\nsecond', 'turn'),
    response([text('first'), text('second')], 'turn'),
    response([image(data)], 'turn'),
  ];
  const firstMessages = await persist(entries('aGk='));
  const first = await db.prisma.closedSession.findFirstOrThrow();
  const original = await readFile(runtime.resolve(first, null), 'utf8');
  await persist(entries('Ynll'));
  const rows = await db.prisma.closedSession.findMany();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.archiveKey)).size).toBe(2);
  expect(JSON.parse(original).messages).toEqual(firstMessages);
  await runtime.archive.stopArchiveMaintenance();
  vi.restoreAllMocks();
  vi.resetModules();
  runtime = await loadRuntime();
  await persist(entries('aGk='));
  expect(await db.prisma.closedSession.count()).toBe(2);
  expect(await readFile(runtime.resolve(first, null), 'utf8')).toBe(original);
  expect(
    (await db.prisma.closedSession.findUniqueOrThrow({ where: { id: first.id } })).archiveKey
  ).toBe(first.archiveKey);
});

it.each(['anonymous', 'different-turn', 'multiple-events', 'unmatched-text'] as const)(
  'retains distinct native prompt records for %s history',
  async (kind) => {
    const turn = kind === 'anonymous' ? undefined : 'turn';
    const entries = [
      event('first', turn),
      response([text('first')], turn),
      ...(kind === 'multiple-events' ? [event('second', turn)] : []),
      response(
        [text(kind === 'unmatched-text' ? 'unmatched' : 'second'), image('aGk=')],
        kind === 'different-turn' ? 'other-turn' : turn
      ),
    ];
    const users = (await load(entries)).filter((message) => message.type === 'user');
    expect(users).toHaveLength(2);
    expect(users[0]?.content).toBe('first');
    expect(users[1]?.content).toBe(kind === 'unmatched-text' ? 'unmatched' : 'second');
    expect(users[0]?.attachments).toBeUndefined();
    expect(users[1]?.attachments).toEqual([expect.objectContaining({ data: 'aGk=' })]);
  }
);

it('does not assign one image-bearing native copy to ambiguous repeated event users', async () => {
  const users = (
    await load([
      event('same', 'turn'),
      event('same', 'turn'),
      response([text('same'), image('aGk=')], 'turn'),
    ])
  ).filter((message) => message.type === 'user');
  expect(users).toHaveLength(3);
  expect(users.slice(0, 2).every((message) => message.attachments === undefined)).toBe(true);
  expect(users[2]?.attachments).toEqual([expect.objectContaining({ data: 'aGk=' })]);
});

it.each(['before', 'between', 'after'] as const)(
  'retains split native image order %s text',
  async (position) => {
    const blocks =
      position === 'before'
        ? [[image('aGk=')], [text('first'), text('second')]]
        : position === 'between'
          ? [[text('first')], [image('aGk='), text('second')]]
          : [[text('first'), text('second')], [image('aGk=')]];
    const users = (
      await load([
        event('first\nsecond', 'turn'),
        ...blocks.map((content) => response(content, 'turn')),
      ])
    ).filter((message) => message.type === 'user');
    expect(users).toHaveLength(1);
    const promptImage = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
    };
    const first = { type: 'text', text: 'first' };
    const second = { type: 'text', text: 'second' };
    expect(users[0]?.providerPrompt).toEqual(
      position === 'before'
        ? [promptImage, first, second]
        : position === 'between'
          ? [first, promptImage, second]
          : [first, second, promptImage]
    );
  }
);

it.each([
  { eventTurn: 'event-turn', responseTurn: 'response-turn', count: 2 },
  { eventTurn: undefined, responseTurn: undefined, count: 1 },
  { eventTurn: 'same-turn', responseTurn: 'same-turn', count: 1 },
])(
  'pairs fallback copies only within compatible turns: $eventTurn/$responseTurn',
  async ({ eventTurn, responseTurn, count }) => {
    const users = (
      await load([event('same', eventTurn), response([text('same'), image('aGk=')], responseTurn)])
    ).filter((message) => message.type === 'user');
    expect(users).toHaveLength(count);
    if (count === 2) {
      expect(users[0]?.attachments).toBeUndefined();
    }
    expect(users.at(-1)?.attachments).toEqual([expect.objectContaining({ data: 'aGk=' })]);
  }
);
