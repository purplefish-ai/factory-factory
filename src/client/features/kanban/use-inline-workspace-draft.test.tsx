// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInlineWorkspaceDraft } from './use-inline-workspace-draft';
import { useWorkspaceCreationSubmission } from './use-workspace-creation-submission';
import * as draftStorage from './workspace-creation-draft-storage';
import {
  createWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

vi.mock('@/client/features/session-selection', async (original) => ({
  ...(await original<typeof import('@/client/features/session-selection')>()),
  useSessionLaunchSelection: () => ({ snapshot: { provider: 'CLAUDE', drafts: {} } }),
}));
type Result = ReturnType<typeof useInlineWorkspaceDraft> & {
  submission: ReturnType<typeof useWorkspaceCreationSubmission>;
};
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness({
  projectId,
  defaultRatchet,
  onResult,
}: {
  projectId: string;
  defaultRatchet: boolean | undefined;
  onResult: (result: Result) => void;
}) {
  const recovery = useInlineWorkspaceDraft(projectId, defaultRatchet);
  const submission = useWorkspaceCreationSubmission(projectId);
  onResult({ ...recovery, submission });
  return null;
}
async function mount(projectId: string, defaultRatchet?: boolean) {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  let current: Result;
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
    unmount() {
      act(() => root.unmount());
      roots.splice(roots.indexOf(root), 1);
    },
    get current() {
      return current;
    },
  };
}
function beginSubmission(submission: Result['submission']) {
  const captured: { token: ReturnType<Result['submission']['begin']> } = { token: null };
  act(() => {
    captured.token = submission.begin();
  });
  if (!captured.token) {
    throw new Error('Expected periodic submission to begin');
  }
  return captured.token;
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

it.each([false, true])(
  'keeps delayed settings from changing a pending periodic revision (remount=%s)',
  async (remount) => {
    const projectId = `pending-periodic-${remount}`;
    let mounted = await mount(projectId);
    act(() => {
      mounted.current.setInitialPrompt('Periodic instructions');
      mounted.current.setMode('PERIODIC_TASK');
    });
    const token = beginSubmission(mounted.current.submission);
    const succeed = mounted.current.submission.succeed;
    if (remount) {
      mounted.unmount();
      mounted = await mount(projectId);
    }
    await mounted.render(true);
    expect(mounted.current.submission.isPending).toBe(true);
    expect(mounted.current.draft.revision).toBe(token.revision);
    expect(mounted.current.draft.ratchetInitialized).toBe(false);
    // IndexedDB is covered in Chromium. Here retain the real logical clear and
    // model a successful persistence boundary in jsdom, which has no IndexedDB.
    const clear = draftStorage.clearWorkspaceCreationDraft;
    vi.spyOn(draftStorage, 'clearWorkspaceCreationDraft').mockImplementation((...args) =>
      clear(...args).catch(() => true)
    );
    let mayClose = false;
    await act(async () => {
      mayClose = await succeed(token);
    });
    expect(mayClose).toBe(!remount);
    expect(mounted.current.hasDraft).toBe(false);
    expect(mounted.current.draft.prompt).toBe('');
    expect(mounted.current.submission.isPending).toBe(false);
  }
);

it('hydrates delayed defaults after a periodic request fails', async () => {
  const mounted = await mount('failed-periodic');
  act(() => {
    mounted.current.setInitialPrompt('Retry these instructions');
    mounted.current.setMode('PERIODIC_TASK');
  });
  const token = beginSubmission(mounted.current.submission);
  await mounted.render(true);
  expect(mounted.current.draft.revision).toBe(token.revision);
  await act(() => mounted.current.submission.fail(token, 'Try again'));
  expect(mounted.current.draft.ratchetEnabled).toBe(true);
  expect(mounted.current.draft.ratchetInitialized).toBe(true);
  expect(mounted.current.draft.prompt).toBe('Retry these instructions');
  expect(mounted.current.draft.revision).not.toBe(token.revision);
});
