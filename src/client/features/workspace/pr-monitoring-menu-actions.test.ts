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
    { mutate, pendingWorkspaceIds: ['w'] }
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
    expectedBindingRevision: 7,
  });
});
it('defaults legacy menu projections to MAIN', () => {
  expect(
    createPRMonitoringMenuProps(
      'w',
      { enabled: false },
      { mutate: vi.fn(), pendingWorkspaceIds: [] }
    ).deliveryMode
  ).toBe('MAIN');
});

it('passes the blocked delivery discard action through only when supplied', () => {
  const discard = vi.fn();
  const toggle = { mutate: vi.fn(), pendingWorkspaceIds: [] };
  const menu = createPRMonitoringMenuProps(
    'w',
    { enabled: true, pauseReason: 'DELIVERY_BLOCKED' },
    toggle,
    discard
  );
  menu.onDiscardBlocked?.();
  expect(discard).toHaveBeenCalledOnce();
  expect(toggle.mutate).not.toHaveBeenCalled();
  expect(createPRMonitoringMenuProps('w', { enabled: true }, toggle)).not.toHaveProperty(
    'onDiscardBlocked'
  );
});

it('marks only the workspace whose toggle is in flight as pending', () => {
  const toggle = { mutate: vi.fn(), pendingWorkspaceIds: ['other'] };
  expect(createPRMonitoringMenuProps('w', { enabled: true }, toggle).pending).toBe(false);
  expect(createPRMonitoringMenuProps('other', { enabled: true }, toggle).pending).toBe(true);
});
