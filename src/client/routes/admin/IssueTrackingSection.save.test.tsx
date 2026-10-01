// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core/enums';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const validResult = {
  valid: true,
  viewerName: 'Mock Viewer',
  teams: [
    { id: 'team-a', name: 'Team A', key: 'A' },
    { id: 'team-b', name: 'Team B', key: 'B' },
  ],
};
const savedInput = {
  id: 'project-1',
  issueProvider: IssueProvider.LINEAR,
  issueTrackerConfig: {
    linear: {
      apiKey: 'mock-key-a',
      teamId: 'team-a',
      teamName: 'Team A (A)',
      viewerName: 'Mock Viewer',
    },
  },
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let requests: Array<{ input: unknown; succeed: () => void; fail: () => void }>;
let validationCount: number;

function button(label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label
  );
}

function input() {
  const element = container.querySelector<HTMLInputElement>('#api-key-project-1');
  expect(element).not.toBeNull();
  return element as HTMLInputElement;
}

function enterKey(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle(action: () => void, pendingMutations = 0) {
  await act(async () => action());
  await vi.waitFor(async () => {
    await act(async () => {
      // Flush React work from any observer notification since the previous poll.
    });
    expect(queryClient.isMutating()).toBe(pendingMutations);
    // Wait for the user-visible observer state as well as the completed transport.
    const provider = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(provider?.disabled).toBe(pendingMutations > 0);
  });
}

async function validate() {
  await settle(() => button('Validate')?.click(), queryClient.isMutating());
}

function selectTeam(label = 'Team A (A)') {
  const trigger = container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[1];
  expect(trigger).toBeDefined();
  act(() => trigger?.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent === label
  );
  expect(option).toBeDefined();
  act(() => option?.click());
}

async function prepareSave() {
  enterKey('mock-key-a');
  await validate();
  selectTeam();
  await settle(() => button('Save')?.click(), 1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toEqual(savedInput);
}

function expectValidated(key = 'mock-key-a', team = 'Team A (A)') {
  expect(input().value).toBe(key);
  expect(container.textContent).toContain('Connected as Mock Viewer');
  expect(container.querySelectorAll('[role="combobox"]')[1]?.textContent).toContain(team);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  validationCount = 0;
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'linear.validateKeyAndListTeams') {
              validationCount += 1;
              observer.next({ result: { data: validResult } });
              observer.complete();
            } else if (op.path === 'project.update') {
              requests.push({
                input: op.input,
                succeed: () => {
                  observer.next({ result: { data: {} } });
                  observer.complete();
                },
                fail: () => observer.error(new TRPCClientError('Mock save failure')),
              });
            } else {
              observer.error(new TRPCClientError(`Unexpected mocked request: ${op.path}`));
            }
          }),
    ],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <ProjectIssueTrackingCard
            projectId="project-1"
            projectName="Alpha"
            currentProvider={IssueProvider.LINEAR}
            issueTrackerConfig={null}
          />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Linear settings save completion', () => {
  it('keeps validated settings during a pending save and after failure for retry', async () => {
    await prepareSave();
    expectValidated();
    expect(button('Saving...')?.disabled).toBe(true);
    await settle(() => requests[0]?.fail());
    expectValidated();
    expect(button('Save')?.disabled).toBe(false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to save: Mock save failure');
    await settle(() => button('Save')?.click(), 1);
    expect(requests[1]?.input).toEqual(savedInput);
    expect(validationCount).toBe(1);
    await settle(() => requests[1]?.succeed());
    expect(input().value).toBe('');
    expect(container.textContent).not.toContain('Connected as');
    expect(button('Save')).toBeUndefined();
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Issue tracking settings saved');
  });

  it('clears the submitted form only after successful save', async () => {
    await prepareSave();
    await settle(() => requests[0]?.succeed());
    expect(input().value).toBe('');
    expect(container.textContent).not.toContain('Connected as');
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(button('Save')).toBeUndefined();
  });

  it.each([false, true])(
    'preserves key edits when an older save succeeds (restore=%s)',
    async (restore) => {
      await prepareSave();
      enterKey('mock-key-b');
      if (restore) {
        enterKey('mock-key-a');
      }
      await settle(() => requests[0]?.succeed());
      expect(input().value).toBe(restore ? 'mock-key-a' : 'mock-key-b');
      expect(container.textContent).not.toContain('Connected as');
    }
  );

  it('preserves a freshly revalidated form when an older save succeeds', async () => {
    await prepareSave();
    await validate();
    selectTeam('Team B (B)');
    await settle(() => requests[0]?.succeed());
    expectValidated('mock-key-a', 'Team B (B)');
    expect(button('Save')?.disabled).toBe(false);
  });

  it.each([false, true])(
    'preserves team edits when an older save succeeds (restore=%s)',
    async (restore) => {
      await prepareSave();
      selectTeam('Team B (B)');
      if (restore) {
        selectTeam();
      }
      await settle(() => requests[0]?.succeed());
      expectValidated('mock-key-a', restore ? 'Team A (A)' : 'Team B (B)');
    }
  );

  it('preserves a newer validated form when an older save fails', async () => {
    await prepareSave();
    enterKey('mock-key-b');
    await validate();
    selectTeam('Team B (B)');
    await settle(() => requests[0]?.fail());
    expectValidated('mock-key-b', 'Team B (B)');
    expect(button('Save')?.disabled).toBe(false);
  });
});
