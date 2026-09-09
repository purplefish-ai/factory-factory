// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RatchetSettingsSection } from './RatchetSettingsSection';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  userSettings: {
    ratchetEnabled: false,
    ratchetReplyToPrComments: true,
    ratchetReviewTriggerMode: 'CHANGES_REQUESTED' as 'CHANGES_REQUESTED' | 'ALL_REVIEW_FEEDBACK',
    ratchetPermissions: 'YOLO',
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      userSettings: { get: { invalidate: vi.fn() } },
    }),
    userSettings: {
      get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
      update: { useMutation: () => ({ mutate: mocks.updateSettingsMutate, isPending: false }) },
    },
    admin: { triggerRatchetCheck: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userSettings.ratchetReviewTriggerMode = 'CHANGES_REQUESTED';
});
afterEach(() => {
  document.body.innerHTML = '';
});
vi.mock('@/client/features/workspace', () => ({ RatchetWrenchIcon: () => createElement('span') }));

describe('RatchetSettingsSection', () => {
  it('updates the Ratchet review feedback trigger mode', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(RatchetSettingsSection));
    });

    expect(container.textContent).toContain('Review feedback trigger');
    const trigger = container.querySelector<HTMLElement>('#ratchet-review-trigger');
    expect(trigger?.textContent).toContain('Changes requested and unresolved threads');

    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Radix portals SelectContent into document.body, outside the render container.
    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
    const broadOption = Array.from(
      listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    ).find((option) => option.textContent?.includes('All review feedback'));
    expect(broadOption).toBeDefined();

    flushSync(() => {
      broadOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      broadOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });

    root.unmount();
  });
});
