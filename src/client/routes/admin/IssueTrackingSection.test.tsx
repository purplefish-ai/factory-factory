// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueProvider } from '@/shared/core/enums';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';

const mocks = vi.hoisted(() => ({ validate: vi.fn(), save: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ project: { list: { invalidate: vi.fn() } } }),
    linear: {
      validateKeyAndListTeams: {
        useMutation: () => ({ mutateAsync: mocks.validate, isPending: false }),
      },
    },
    project: { update: { useMutation: () => ({ mutate: mocks.save, isPending: false }) } },
  },
}));

const validResult = {
  valid: true,
  viewerName: 'Mock Viewer A',
  teams: [{ id: 'team-a', name: 'Team A', key: 'A' }],
};
let root: Root;
let container: HTMLDivElement;

function renderCard() {
  act(() => {
    root.render(
      createElement(ProjectIssueTrackingCard, {
        projectId: 'project-1',
        projectName: 'Alpha',
        currentProvider: IssueProvider.LINEAR,
        issueTrackerConfig: null,
      })
    );
  });
}

function button(label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label
  );
}

function enterKey(value: string) {
  const input = container.querySelector<HTMLInputElement>('#api-key-project-1');
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function validate() {
  await act(async () => button('Validate')?.click());
}

function selectTeam(label = 'Team A (A)') {
  const trigger = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')
  ).find((item) => item.textContent?.includes('Select a team'));
  expect(trigger).toBeDefined();
  act(() => trigger?.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent === label
  );
  expect(option).toBeDefined();
  act(() => option?.click());
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.save.mockReset();
  mocks.validate.mockReset().mockResolvedValue(validResult);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderCard();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Linear key/team validation', () => {
  it('saves a team validated against the current key', async () => {
    enterKey('mock-key-a');
    await validate();
    selectTeam();
    act(() => button('Save')?.click());
    expect(mocks.save).toHaveBeenCalledWith({
      id: 'project-1',
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig: {
        linear: {
          apiKey: 'mock-key-a',
          teamId: 'team-a',
          teamName: 'Team A (A)',
          viewerName: 'Mock Viewer A',
        },
      },
    });
  });

  it.each(['mock-key-b', ''])('requires revalidation after changing the key to %j', async (key) => {
    enterKey('mock-key-a');
    await validate();
    selectTeam();
    enterKey(key);
    act(() => button('Save')?.click());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Connected as');
    expect(button('Save')).toBeUndefined();
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(1);
  });

  it.each([false, true])(
    'ignores a validation response after editing the key (restore=%s)',
    async (restore) => {
      let resolve!: (result: typeof validResult) => void;
      mocks.validate.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      );
      enterKey('mock-key-a');
      await validate();
      enterKey('mock-key-b');
      if (restore) {
        enterKey('mock-key-a');
      }
      await act(async () => resolve(validResult));
      expect(container.textContent).not.toContain('Connected as');
      expect(button('Save')).toBeUndefined();
      expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    }
  );

  it.each(['invalid', 'transport'])(
    'clears old validation when a retry fails (%s)',
    async (failure) => {
      enterKey('mock-key-a');
      await validate();
      selectTeam();
      if (failure === 'invalid') {
        mocks.validate.mockResolvedValue({ valid: false, error: 'Invalid key' });
      } else {
        mocks.validate.mockRejectedValue(new Error('Request failed'));
      }
      await validate();
      act(() => button('Save')?.click());
      expect(mocks.save).not.toHaveBeenCalled();
      expect(button('Save')).toBeUndefined();
      expect(container.textContent).not.toContain('Connected as');
    }
  );

  it('requires a fresh team selection after validating the edited key', async () => {
    enterKey('mock-key-a');
    await validate();
    selectTeam();
    enterKey('mock-key-b');
    mocks.validate.mockResolvedValue({
      valid: true,
      viewerName: 'Mock Viewer B',
      teams: [{ id: 'team-b', name: 'Team B', key: 'B' }],
    });
    await validate();
    expect(button('Save')?.disabled).toBe(true);
    selectTeam('Team B (B)');
    act(() => button('Save')?.click());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        issueTrackerConfig: {
          linear: {
            apiKey: 'mock-key-b',
            teamId: 'team-b',
            teamName: 'Team B (B)',
            viewerName: 'Mock Viewer B',
          },
        },
      })
    );
  });
});
