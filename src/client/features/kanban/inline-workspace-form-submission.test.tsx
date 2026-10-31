import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { actFlushSync } from '@/test-utils/react-act';
// @vitest-environment jsdom
import { getTestProjectId, mocks, renderForm } from './inline-workspace-form.test-harness';
import type { WorkspaceCreationSubmission } from './use-workspace-creation-submission';
import {
  createWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

type Input = { type: 'MANUAL'; projectId: string; name: string };
type Context = { optimisticWorkspaceId: string; submission?: WorkspaceCreationSubmission | null };
type Options = {
  onMutate: (input: Input) => Promise<Context>;
  onError: (error: Error, input: Input, context: Context) => void;
  onSuccess: (
    workspace: ReturnType<typeof createOptimisticWorkspaceSummary>,
    input: Input,
    context: Context
  ) => void;
};
function options() {
  return mocks.createWorkspaceMutationOptions as unknown as Options;
}
function launch(container: HTMLElement, label = 'Launch') {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label
  );
  expect(button).toBeDefined();
  actFlushSync(() => button?.click());
}

describe('workspace creation submission recovery', () => {
  it('explains a cleanup failure after production storage has already cleared the draft in memory', async () => {
    await saveWorkspaceCreationDraft(getTestProjectId(), {
      ...createWorkspaceCreationDraft(),
      prompt: 'Create this task',
    }).catch(() => undefined);
    const form = renderForm();
    try {
      launch(form.container);
      const input = mocks.createWorkspaceMutateMock.mock.calls[0]?.[0] as Input;
      const mutation = options();
      const context = await mutation.onMutate(input);
      await act(async () => {
        await mutation.onSuccess(
          createOptimisticWorkspaceSummary({
            id: 'created',
            projectId: input.projectId,
            name: input.name,
            ratchetEnabled: false,
          }),
          input,
          context
        );
      });
      expect(getWorkspaceCreationDraftSnapshot(input.projectId).draft).toBeNull();
      expect(form.container.textContent).toContain('Task created');
      expect(form.container.textContent).toContain('saved draft may reappear after a refresh');
      expect(form.container.textContent).not.toContain('Discard draft');
      expect(form.onCreated).not.toHaveBeenCalled();
      expect(
        [...form.container.querySelectorAll('button')].find((button) =>
          ['Launch', 'Create Agent'].includes(button.textContent ?? '')
        )?.disabled
      ).toBe(false);
    } finally {
      actFlushSync(() => form.root.unmount());
    }
  });

  it('preserves a newer draft when a submitted periodic task succeeds late', async () => {
    await saveWorkspaceCreationDraft(getTestProjectId(), {
      ...createWorkspaceCreationDraft(),
      mode: 'PERIODIC_TASK',
      cadence: 'EVERY_FIVE_MINUTES',
      prompt: 'Retained periodic review',
    }).catch(() => undefined);
    const form = renderForm();
    try {
      launch(form.container, 'Create Agent');
      expect(mocks.createPeriodicTaskMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Retained periodic review' })
      );
      const mutation = mocks.agentMutationOptions!;
      const context = mutation.onMutate!();
      expect(context).toMatchObject({
        submission: { projectId: getTestProjectId(), revision: expect.any(String) },
      });
      const newer = { ...createWorkspaceCreationDraft(), prompt: 'A newer task' };
      await act(async () => {
        await saveWorkspaceCreationDraft(getTestProjectId(), newer).catch(() => undefined);
      });
      const revisionBeforeSuccess =
        getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft?.revision;
      await act(async () => {
        await mutation.onSuccess(
          { name: 'Periodic review', projectId: getTestProjectId() },
          mocks.createPeriodicTaskMutateMock.mock.calls[0]?.[0],
          context
        );
      });
      expect(getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft?.revision).toBe(
        revisionBeforeSuccess
      );
      expect(getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft?.prompt).toBe(
        'A newer task'
      );
      expect(form.onCancel).not.toHaveBeenCalled();
      expect(
        [...form.container.querySelectorAll('button')].find((button) =>
          ['Launch', 'Create Agent'].includes(button.textContent ?? '')
        )?.disabled
      ).toBe(false);
    } finally {
      actFlushSync(() => form.root.unmount());
    }
  });

  it('retains instructions, attachments and launch choices beside a request error and retries them', async () => {
    const attachments = [
      {
        id: 'notes',
        name: 'notes.txt',
        type: 'text/plain',
        size: 4,
        data: 'text',
        contentType: 'text' as const,
      },
    ];
    await saveWorkspaceCreationDraft(getTestProjectId(), {
      ...createWorkspaceCreationDraft(),
      prompt: 'Keep all of this task',
      attachments,
    }).catch(() => undefined);
    const form = renderForm();
    try {
      actFlushSync(() =>
        form.container.querySelector<HTMLButtonElement>('[aria-label="Choose Codex"]')?.click()
      );
      launch(form.container);
      const input = mocks.createWorkspaceMutateMock.mock.calls[0]?.[0] as Input;
      let context: Context;
      await act(async () => {
        context = await options().onMutate(input);
      });
      actFlushSync(() => options().onError(new Error('Git is unavailable'), input, context!));
      expect(form.textarea.value).toBe('Keep all of this task');
      expect(
        [...form.container.querySelectorAll('[role="alert"]')].some((el) =>
          el.textContent?.includes('Git is unavailable')
        )
      ).toBe(true);
      expect(getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft?.attachments).toEqual(
        attachments
      );
      launch(form.container);
      expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledTimes(2);
      expect(mocks.createWorkspaceMutateMock.mock.calls[1]?.[0]).toMatchObject({
        initialPrompt: 'Keep all of this task',
        initialAttachments: attachments,
        provider: 'CODEX',
      });
      expect(
        [...form.container.querySelectorAll('[role="alert"]')].some((el) =>
          el.textContent?.includes('Git is unavailable')
        )
      ).toBe(false);
    } finally {
      actFlushSync(() => form.root.unmount());
    }
  });

  it('keeps a pending request across remount and displays its eventual failure in the resumed form', async () => {
    await saveWorkspaceCreationDraft(getTestProjectId(), {
      ...createWorkspaceCreationDraft(),
      prompt: 'Pending task',
    }).catch(() => undefined);
    const first = renderForm();
    launch(first.container);
    const input = mocks.createWorkspaceMutateMock.mock.calls[0]?.[0] as Input;
    const original = options();
    let context: Context;
    await act(async () => {
      context = await original.onMutate(input);
    });
    actFlushSync(() => first.root.unmount());
    const resumed = renderForm();
    try {
      launch(resumed.container);
      expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledTimes(1);
      actFlushSync(() => original.onError(new Error('Creation interrupted'), input, context!));
      expect(resumed.textarea.value).toBe('Pending task');
      expect(
        [...resumed.container.querySelectorAll('[role="alert"]')].some((el) =>
          el.textContent?.includes('Creation interrupted')
        )
      ).toBe(true);
      launch(resumed.container);
      expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledTimes(2);
    } finally {
      actFlushSync(() => resumed.root.unmount());
    }
  });

  it.each(['FAILED', 'READY'] as const)(
    'preserves a newer %s snapshot that arrives before the create response',
    async (status) => {
      const form = renderForm();
      const input: Input = { type: 'MANUAL', projectId: getTestProjectId(), name: 'New task' };
      const mutation = options();
      let context: Context;
      await act(async () => {
        context = await mutation.onMutate(input);
      });
      const canonical = {
        ...createOptimisticWorkspaceSummary({
          id: 'real-id',
          projectId: input.projectId,
          name: 'Canonical task',
          ratchetEnabled: true,
        }),
        status,
        kanbanColumn: 'WAITING' as const,
        isWorking: false,
        initErrorMessage: status === 'FAILED' ? 'Worktree creation failed' : null,
        statusReason:
          status === 'FAILED'
            ? {
                code: 'SETUP_FAILED' as const,
                label: 'Setup failed',
                tone: 'danger' as const,
                needsUser: true,
              }
            : {
                code: 'NO_SESSION_STARTED' as const,
                label: 'No session started',
                tone: 'neutral' as const,
                needsUser: true,
              },
      };
      mocks.workspaceListCache = {
        workspaces: [canonical, { id: context!.optimisticWorkspaceId }, { id: 'concurrent' }],
        reviewCount: 7,
      };
      const response = createOptimisticWorkspaceSummary({
        id: 'real-id',
        projectId: input.projectId,
        name: 'New task',
        ratchetEnabled: true,
      });
      try {
        actFlushSync(() => mutation.onSuccess(response, input, context!));
        expect(mocks.workspaceListCache?.workspaces).toEqual([canonical, { id: 'concurrent' }]);
        expect(mocks.workspaceListCache?.reviewCount).toBe(7);
      } finally {
        actFlushSync(() => form.root.unmount());
      }
    }
  );
});
