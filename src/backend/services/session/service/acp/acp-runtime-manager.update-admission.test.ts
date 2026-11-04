import { expect, it, vi } from 'vitest';
import { ApplicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import {
  AcpRuntimeManager,
  mockPrompt,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

it('ignores idle live clients, counts pending prompt preparation and rejects new work while fenced', async () => {
  const admission = new ApplicationUpdateAdmission();
  const manager = new AcpRuntimeManager({ admission });
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session-1',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  expect(admission.tryClose(() => false)).toBe(true);
  await expect(
    manager.getOrCreateClient('session-2', defaultOptions(), defaultHandlers(), defaultContext())
  ).rejects.toThrow('update');
  await expect(
    manager.sendPrompt('session-1', [{ type: 'text', text: 'Blocked' }])
  ).rejects.toThrow('update');
  admission.release();
  const ready = createDeferred<void>();
  let pendingConfiguration: Promise<void> | undefined = ready.promise;
  vi.spyOn(handle, 'configurationReady', 'get').mockImplementation(() => pendingConfiguration);
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const prompt = manager.sendPrompt('session-1', [{ type: 'text', text: 'Work' }]);
  expect(admission.tryClose(() => false)).toBe(false);
  pendingConfiguration = undefined;
  ready.resolve();
  await prompt;
  expect(admission.tryClose(() => false)).toBe(true);
});

it('accepts composition-owned admission configuration for pending creation operations', async () => {
  const admission = new ApplicationUpdateAdmission();
  const manager = new AcpRuntimeManager();
  manager.configureAdmission(admission);
  admission.tryClose(() => false);
  await expect(
    manager.runClientCreationOperation('s1', 'active', async () => undefined)
  ).rejects.toThrow('update');
});
