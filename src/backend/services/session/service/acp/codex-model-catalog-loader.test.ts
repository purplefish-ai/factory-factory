import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchCodexModelCatalogFromAppServer } from './codex-model-catalog-loader';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

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

beforeEach(() => {
  requests = [];
  malformed = false;
  noisy = false;
  reasoningDescription = undefined;
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
      const result =
        request.method === 'initialize'
          ? {}
          : malformed
            ? { data: [{ id: 42 }] }
            : request.params?.cursor
              ? { data: [{ ...model, id: 'model-2' }], nextCursor: null }
              : {
                  data: [
                    {
                      ...model,
                      supportedReasoningEfforts: [
                        { reasoningEffort: 'high', description: reasoningDescription },
                      ],
                    },
                  ],
                  nextCursor: 'page-2',
                };
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
