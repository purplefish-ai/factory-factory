// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useInlineWorkspaceDraft } from './use-inline-workspace-draft';
import {
  createWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

vi.mock('@/client/features/session-selection', async (original) => ({
  ...(await original<typeof import('@/client/features/session-selection')>()),
  useSessionLaunchSelection: () => ({ snapshot: { provider: 'CLAUDE', drafts: {} } }),
}));
const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
});
function Harness({
  projectId,
  defaultRatchet,
  onResult,
}: {
  projectId: string;
  defaultRatchet: boolean | undefined;
  onResult: (result: ReturnType<typeof useInlineWorkspaceDraft>) => void;
}) {
  onResult(useInlineWorkspaceDraft(projectId, defaultRatchet));
  return null;
}
async function mount(projectId: string, defaultRatchet?: boolean) {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  let current: ReturnType<typeof useInlineWorkspaceDraft>;
  const render = async (value?: boolean) => {
    await act(() =>
      root.render(
        createElement(Harness, {
          projectId,
          defaultRatchet: value,
          onResult: (result) => {
            current = result;
          },
        })
      )
    );
  };
  await render(defaultRatchet);
  return {
    render,
    get current() {
      return current;
    },
  };
}
it('hydrates an unresolved ratchet default after instructions were typed', async () => {
  const mounted = await mount('delayed-ratchet');
  act(() => mounted.current.setInitialPrompt('Typed before settings'));
  await mounted.render(true);
  expect(mounted.current.ratchetEnabled).toBe(true);
  expect(mounted.current.draft.ratchetEnabled).toBe(true);
  expect(mounted.current.draft.prompt).toBe('Typed before settings');
  await mounted.render(false);
  expect(mounted.current.ratchetEnabled).toBe(true);
});
it('preserves an explicit ratchet choice when delayed settings arrive', async () => {
  const mounted = await mount('explicit-ratchet');
  act(() => mounted.current.setRatchetEnabled(false));
  await mounted.render(true);
  expect(mounted.current.ratchetEnabled).toBe(false);
});
it('preserves restored ratchet choices when settings arrive', async () => {
  await saveWorkspaceCreationDraft('restored-ratchet', {
    ...createWorkspaceCreationDraft(),
    prompt: 'Saved',
    ratchetEnabled: false,
    ratchetInitialized: true,
  }).catch(() => undefined);
  const mounted = await mount('restored-ratchet');
  await mounted.render(true);
  expect(mounted.current.ratchetEnabled).toBe(false);
});
