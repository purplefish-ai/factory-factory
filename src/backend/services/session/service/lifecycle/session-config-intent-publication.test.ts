import { expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { setupAuthority } from './session-config-authority.test-helpers';

it('persists desired queued settings before publishing or acknowledging a native configuration edit', async () => {
  const gate = createDeferred<void>();
  const override = vi.fn(() => gate.promise);
  const h = setupAuthority(undefined, { override });
  const pending = h.service.setSessionModel('session', 'second', 'user');
  await vi.waitFor(() => expect(override).toHaveBeenCalledOnce());
  expect(h.models()).toEqual([]);
  gate.resolve();
  await pending;
  expect(h.models()).toEqual(['second']);
});
