import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';

const dirs: string[] = [];
const handles: AcpProcessHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.child.stdin?.end();
    await cleanupFailedAcpClientCreation(handle.child, 'contract-session');
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

it('runs the released adapter with native config, image input and legacy identity resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-upstream-contract-'));
  dirs.push(dir);
  const fake = join(dir, 'codex');
  await copyFile(
    new URL('../../../../testing/fixtures/fake-codex-app-server.mjs', import.meta.url),
    fake
  );
  await chmod(fake, 0o755);
  const log = join(dir, 'requests.jsonl');
  const factory = new AcpClientFactory();
  factory.configureEnvironment({
    childProcessEnvProvider: () => ({
      PATH: process.env.PATH,
      HOME: dir,
      CODEX_HOME: dir,
      CODEX_PATH: fake,
      FF_ACP_PROBE_LOG: log,
    }),
  });
  const never = {
    promise: new Promise<never>(() => {
      /* No cancellation during the contract test. */
    }),
    dispose() {
      /* Test signal has no listeners. */
    },
  };
  const create = async (resumeProviderSessionId?: string) => {
    const handle = await factory.createClient({
      sessionId: 'contract-session',
      options: {
        provider: 'CODEX',
        workingDir: dir,
        sessionId: 'contract-session',
        resumeProviderSessionId,
      },
      handlers: {},
      metadata: { incarnationId: 'contract', purpose: 'active', installed: false },
      shutdownSignal: never,
      stopSignal: never,
      shouldDispatchRuntimeError: () => false,
    });
    handles.push(handle);
    return handle;
  };
  const handle = await create();
  expect(handle.supportsImages()).toBe(true);
  expect(handle.configOptions.map((option) => option.id)).toContain('collaboration_mode');
  const updated = await handle.connection.setSessionConfigOption({
    sessionId: handle.providerSessionId,
    configId: 'mode',
    value: 'read-only',
  });
  expect(updated.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
    'read-only'
  );
  await expect(
    handle.connection.prompt({
      sessionId: handle.providerSessionId,
      prompt: [
        { type: 'text', text: 'Synthetic contract prompt' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ],
    })
  ).resolves.toMatchObject({ stopReason: 'end_turn' });
  const legacy = `sess_${handle.providerSessionId}`;
  const resumed = await create(legacy);
  expect(resumed.providerSessionId).toBe(legacy);
  expect(resumed.sessionCreationOutcome.kind).toBe('resumed');
  const requests = z
    .array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() }))
    .parse(
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    );
  expect(requests.some((request) => request.method === 'config/value/write')).toBe(false);
  expect(requests.find((request) => request.method === 'thread/resume')?.params?.threadId).toBe(
    handle.providerSessionId
  );
  const prompt = requests.find(
    (request) =>
      request.method === 'turn/start' && request.params?.threadId === handle.providerSessionId
  );
  expect(prompt?.params).toMatchObject({
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'readOnly' },
    input: expect.arrayContaining([{ type: 'image', url: 'data:image/png;base64,AA==' }]),
  });
}, 20_000);
