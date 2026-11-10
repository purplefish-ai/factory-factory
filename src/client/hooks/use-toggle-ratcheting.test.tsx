// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PRRecipientChoice } from '@/client/features/workspace/pr-recipient-picker';
import { useToggleRatcheting, type ToggleRatchetingInput } from './use-toggle-ratcheting';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateDetail: vi.fn(),
  invalidateList: vi.fn(),
  options: null as null | {
    onSuccess(
      result: {
        status: 'recipient_required';
        bindingRevision: number;
        candidates: PRRecipientChoice[];
      },
      input: ToggleRatchetingInput
    ): void;
    onError(error: Error): void;
    onSettled(data: unknown, error: Error | null, input: ToggleRatchetingInput): void;
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: { invalidate: mocks.invalidateDetail },
        listForProject: { invalidate: mocks.invalidateList },
      },
    }),
    workspace: {
      toggleRatcheting: {
        _def: () => ({ path: ['workspace', 'toggleRatcheting'] }),
        useMutation: (options: NonNullable<typeof mocks.options>) => {
          mocks.options = options;
          return { mutate: mocks.mutate, mutateAsync: mocks.mutate, isPending: false };
        },
      },
    },
  },
}));
vi.mock('@/client/features/workspace/pr-recipient-picker', () => ({
  PRRecipientPicker: ({
    candidates,
    onSelect,
  }: {
    candidates: PRRecipientChoice[];
    onSelect(id: string): void;
  }) => (
    <div data-testid="recipient-picker">
      {candidates.map((candidate) => (
        <button key={candidate.id} onClick={() => onSelect(candidate.id)}>
          Choose {candidate.name ?? candidate.id}
        </button>
      ))}
    </div>
  ),
}));
let root: Root;
let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  document.body.innerHTML = '';
});
function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
function RecipientPicker() {
  return useToggleRatcheting('p').recipientPicker;
}
function Harness() {
  return (
    <Providers>
      <RecipientPicker />
    </Providers>
  );
}

/** Starts a toggle request that stays in flight until the returned resolver runs. */
function startToggle(input: ToggleRatchetingInput): () => void {
  let finish!: () => void;
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: [['workspace', 'toggleRatcheting']],
    mutationFn: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  void mutation.execute(input);
  return () => finish();
}

let pending: readonly string[] = [];
function PendingProbe() {
  pending = useToggleRatcheting('p').pendingWorkspaceIds;
  return null;
}

it('reports every workspace with a toggle in flight, not just the latest', async () => {
  await act(() =>
    root.render(
      <Providers>
        <PendingProbe />
      </Providers>
    )
  );
  // React Query batches cache notifications onto a timer.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let finishFirst!: () => void;
  await act(async () => {
    finishFirst = startToggle({ workspaceId: 'first', enabled: true });
    startToggle({ workspaceId: 'second', enabled: false });
    await flush();
  });
  expect(pending).toEqual(['first', 'second']);
  await act(async () => {
    finishFirst();
    await flush();
  });
  expect(pending).toEqual(['second']);
});
it('preserves MAIN destination and the new revision when choosing a recipient', async () => {
  await act(() => root.render(<Harness />));
  await act(() =>
    mocks.options!.onSuccess(
      {
        status: 'recipient_required',
        bindingRevision: 7,
        candidates: [{ id: 'main-7', name: 'Implementation', provider: 'claude' }],
      },
      {
        workspaceId: 'w',
        enabled: true,
        deliveryMode: 'MAIN',
        expectedBindingRevision: 7,
      }
    )
  );
  await act(() => document.querySelector('button')!.click());
  expect(mocks.mutate).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    recipientSessionId: 'main-7',
    expectedBindingRevision: 7,
  });
});
it('does not request an existing recipient for dedicated mode', async () => {
  await act(() => root.render(<Harness />));
  await act(() =>
    mocks.options!.onSuccess(
      { status: 'recipient_required', bindingRevision: 7, candidates: [] },
      {
        workspaceId: 'w',
        enabled: true,
        deliveryMode: 'DEDICATED',
      }
    )
  );
  expect(document.querySelector('[data-testid="recipient-picker"]')).toBeNull();
});

it('preserves the explicit resume request through MAIN recipient selection', async () => {
  await act(() => root.render(<Harness />));
  await act(() =>
    mocks.options!.onSuccess(
      {
        status: 'recipient_required',
        bindingRevision: 9,
        candidates: [{ id: 'main-9', name: 'Follow-up', provider: 'codex' }],
      },
      { workspaceId: 'w', enabled: true, deliveryMode: 'MAIN', resume: true }
    )
  );
  await act(() => document.querySelector('button')!.click());
  expect(mocks.mutate).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    resume: true,
    recipientSessionId: 'main-9',
    expectedBindingRevision: 9,
  });
});

it('does not open a recipient picker when choosing MAIN while monitoring is off', async () => {
  await act(() => root.render(<Harness />));
  await act(() =>
    mocks.options!.onSuccess(
      { status: 'recipient_required', bindingRevision: 9, candidates: [] },
      { workspaceId: 'w', enabled: false, deliveryMode: 'MAIN' }
    )
  );
  expect(document.querySelector('[data-testid="recipient-picker"]')).toBeNull();
});

it('renders the picker marker even when MAIN has no available candidates', async () => {
  await act(() => root.render(<Harness />));
  await act(() =>
    mocks.options!.onSuccess(
      { status: 'recipient_required', bindingRevision: 9, candidates: [] },
      { workspaceId: 'w', enabled: true, deliveryMode: 'MAIN' }
    )
  );
  expect(document.querySelector('[data-testid="recipient-picker"]')).not.toBeNull();
  expect(document.querySelector('button')).toBeNull();
});

it('keeps the captured revision when choosing from a stale picker and reloads settings on rejection', async () => {
  await act(() => root.render(<Harness />));
  const input = {
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN' as const,
    recipientSessionId: null,
    expectedBindingRevision: 7,
  };
  await act(() =>
    mocks.options!.onSuccess(
      {
        status: 'recipient_required',
        bindingRevision: 7,
        candidates: [{ id: 'chosen', name: 'Implementation', provider: 'claude' }],
      },
      input
    )
  );
  // New settings may be saved while this dialog remains open; selection must keep its original CAS.
  await act(() => document.querySelector('button')!.click());
  const selectedInput = {
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN' as const,
    recipientSessionId: 'chosen',
    expectedBindingRevision: 7,
  };
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith(selectedInput);
  const error = new Error('PR monitoring changed; refresh and retry');
  await act(() => {
    mocks.options!.onError(error);
    mocks.options!.onSettled(undefined, error, selectedInput);
  });
  expect(document.querySelector('[data-testid="recipient-picker"]')).toBeNull();
  expect(mocks.invalidateDetail).toHaveBeenCalledWith({ id: 'w' });
  expect(mocks.invalidateList).toHaveBeenCalledWith({ projectId: 'p' });
});
