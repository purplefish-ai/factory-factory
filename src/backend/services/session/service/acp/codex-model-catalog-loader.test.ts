import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchCodexModelCatalogFromAppServer } from './codex-model-catalog-loader';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), debug: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/backend/services/logger.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backend/services/logger.service')>()),
  createLogger: () => ({ debug: mocks.debug }),
}));

const model = {
  id: 'model-1',
  displayName: 'Model One',
  description: 'Available model',
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  inputModalities: ['text', 'image'],
  isDefault: true,
};
let requests: Array<{ id?: number; method: string; params?: { cursor?: string } }>;
let malformed = false;
let noisy = false;
let reasoningDescription: string | null | undefined;
let overloads = 0;
let errorCode = -32_001;

function modelResult(request: { method: string; params?: { cursor?: string } }): unknown {
  if (request.method === 'initialize') {
    return {};
  }
  if (malformed) {
    return { data: [{ id: 42 }] };
  }
  if (request.params?.cursor) {
    return { data: [{ ...model, id: 'model-2' }], nextCursor: null };
  }
  return {
    data: [
      {
        ...model,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: reasoningDescription }],
      },
    ],
    nextCursor: 'page-2',
  };
}

beforeEach(() => {
  requests = [];
  malformed = false;
  noisy = false;
  reasoningDescription = undefined;
  overloads = 0;
  errorCode = -32_001;
  mocks.spawn.mockReset();
  mocks.debug.mockClear();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = 'SIGTERM';
        child.emit('exit');
        return true;
      }),
    });
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      if (request.id === undefined) {
        return;
      }
      if (request.method === 'model/list' && overloads-- > 0) {
        queueMicrotask(() =>
          child.stdout.write(
            `${JSON.stringify({ id: request.id, error: { code: errorCode, message: 'overloaded' } })}\n`
          )
        );
        return;
      }
      const result = modelResult(request);
      queueMicrotask(() => {
        if (noisy) {
          child.stdout.write('Adapter startup diagnostic\n');
        }
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    });
    return child;
  });
});

it('discovers paginated models using the same packaged Codex runtime as sessions', async () => {
  const result = await fetchCodexModelCatalogFromAppServer();
  expect(result.map((entry) => entry.id)).toEqual(['model-1', 'model-2']);
  expect(result[0]).toEqual(model);
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.execPath,
    [expect.stringContaining('codex-acp'), 'cli', 'app-server'],
    expect.any(Object)
  );
  expect(requests.map((request) => request.method)).toEqual([
    'initialize',
    'initialized',
    'model/list',
    'model/list',
  ]);
  expect(requests[3]?.params).toEqual({ cursor: 'page-2' });
});

it('rejects malformed provider model data and closes discovery', async () => {
  malformed = true;
  await expect(fetchCodexModelCatalogFromAppServer()).rejects.toThrow();
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('normalizes nullable reasoning descriptions without dropping the catalog', async () => {
  reasoningDescription = null;
  const result = await fetchCodexModelCatalogFromAppServer();
  expect(result[0]?.supportedReasoningEfforts).toEqual([
    { reasoningEffort: 'high', description: undefined },
  ]);
});

it('ignores non-JSON startup diagnostics and still discovers models', async () => {
  noisy = true;
  await expect(fetchCodexModelCatalogFromAppServer()).resolves.toHaveLength(2);
});

it('retries transient model-list overloads with a bounded attempt count', async () => {
  overloads = 2;
  await expect(fetchCodexModelCatalogFromAppServer()).resolves.toHaveLength(2);
  expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(4);
});

it('stops after three model-list overload attempts and closes the current process', async () => {
  overloads = 20;
  await expect(fetchCodexModelCatalogFromAppServer()).rejects.toThrow('overloaded');
  expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(3);
  expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
});

it('does not retry other model-list failures', async () => {
  overloads = 1;
  errorCode = -32_000;
  await expect(fetchCodexModelCatalogFromAppServer()).rejects.toThrow('overloaded');
  expect(requests.filter((request) => request.method === 'model/list')).toHaveLength(1);
});

it('retains stderr diagnostics for discovery failures', async () => {
  const discovering = fetchCodexModelCatalogFromAppServer();
  mocks.spawn.mock.results[0]?.value.stderr.write('startup diagnostic');
  await discovering;
  expect(mocks.debug).toHaveBeenCalledWith('Codex catalog stderr', { data: 'startup diagnostic' });
});
