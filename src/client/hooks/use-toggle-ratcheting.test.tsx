// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PRRecipientChoice } from '@/client/features/workspace/pr-recipient-picker';
import { useToggleRatcheting, type ToggleRatchetingInput } from './use-toggle-ratcheting';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  options: null as null | {
    onSuccess(
      result: {
        status: 'recipient_required';
        bindingRevision: number;
        candidates: PRRecipientChoice[];
      },
      input: ToggleRatchetingInput
    ): void;
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { get: { invalidate: vi.fn() }, listForProject: { invalidate: vi.fn() } },
    }),
    workspace: {
      toggleRatcheting: {
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
    <>
      {candidates.map((candidate) => (
        <button key={candidate.id} onClick={() => onSelect(candidate.id)}>
          Choose {candidate.name ?? candidate.id}
        </button>
      ))}
    </>
  ),
}));
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.mutate.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
function Harness() {
  const toggle = useToggleRatcheting('p');
  return toggle.recipientPicker;
}
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
  expect(document.querySelector('button')).toBeNull();
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
  expect(document.querySelector('button')).toBeNull();
});
