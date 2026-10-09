import { expect, it, vi } from 'vitest';
import { createPRMonitoringMenuProps } from './pr-monitoring-menu-actions';

it('keeps monitoring toggles independent from the rendered mode and guards explicit changes', () => {
  const mutate = vi.fn();
  const menu = createPRMonitoringMenuProps(
    'w',
    {
      enabled: false,
      deliveryMode: 'DEDICATED',
      bindingRevision: 7,
      pauseReason: 'SESSION_FAILED',
    },
    { mutate, isPending: true }
  );
  expect(menu).toMatchObject({
    enabled: false,
    deliveryMode: 'DEDICATED',
    pending: true,
    pauseReason: 'SESSION_FAILED',
  });
  menu.onToggle(true);
  expect(mutate).toHaveBeenLastCalledWith({ workspaceId: 'w', enabled: true });
  menu.onDeliveryMode('MAIN');
  expect(mutate).toHaveBeenLastCalledWith({
    workspaceId: 'w',
    enabled: false,
    deliveryMode: 'MAIN',
    expectedBindingRevision: 7,
  });
  menu.onResume?.();
  expect(mutate).toHaveBeenLastCalledWith({
    workspaceId: 'w',
    enabled: true,
    resume: true,
    deliveryMode: 'DEDICATED',
    expectedBindingRevision: 7,
  });
  menu.onChangeRecipient();
  expect(mutate).toHaveBeenLastCalledWith({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    recipientSessionId: null,
  });
});
it('defaults legacy menu projections to MAIN', () => {
  expect(
    createPRMonitoringMenuProps('w', { enabled: false }, { mutate: vi.fn(), isPending: false })
      .deliveryMode
  ).toBe('MAIN');
});
