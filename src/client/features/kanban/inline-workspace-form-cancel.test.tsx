// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { getTestProjectId, mocks, renderForm } from './inline-workspace-form.test-harness';
import {
  createWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

it('clears canceled instructions and options so reopening uses current user defaults', async () => {
  await saveWorkspaceCreationDraft(getTestProjectId(), {
    ...createWorkspaceCreationDraft(),
    prompt: 'Discard these instructions',
    mode: 'PERIODIC_TASK',
    cadence: 'WEEKLY',
    scheduledTime: '09:30',
    ratchetEnabled: !mocks.userSettings.ratchetEnabled,
    ratchetInitialized: true,
    launchSelection: {
      provider: 'CODEX',
      drafts: { CODEX: { model: 'chosen-model', reasoningEffort: 'high', planModeEnabled: true } },
    },
  }).catch(() => undefined);
  const first = renderForm();
  expect(first.textarea.value).toBe('Discard these instructions');
  actFlushSync(() =>
    [...first.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click()
  );
  actFlushSync(() => first.root.unmount());
  await act(() => Promise.resolve());
  expect(getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft).toBeNull();
  const second = renderForm();
  expect(second.textarea.value).toBe('');
  expect(second.container.querySelector('input[type="time"]')).toBeNull();
  expect(second.container.textContent).toContain('Launch');
  expect(second.container.textContent).not.toContain('chosen-model');
  expect(second.container.textContent).toContain(mocks.userSettings.defaultSessionProvider);
  actFlushSync(() => second.root.unmount());
});
