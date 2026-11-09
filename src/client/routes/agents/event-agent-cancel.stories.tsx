import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AgentsPage } from '@/client/features/agents/agents-page';
import {
  eventAgentFixture,
  eventSummaryFixture,
} from '@/client/features/agents/event-agent.test-support';
import {
  createWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  WORKSPACE_DRAFT_DATABASE_NAME,
  WORKSPACE_DRAFT_DATABASE_VERSION,
  WORKSPACE_DRAFT_STORE_NAME,
} from '@/client/features/kanban/workspace-creation-draft-storage';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { EventAgentWorkspaceForm } from './event-agent-workspace-form';
import { eventWorkspaceHandlers } from './event-agent-workspace-form.story-fixtures';

const project = { id: 'cancel-event-story', slug: 'factory', name: 'Factory' };
const event = { ...eventAgentFixture(), projectId: project.id };
const eventKey = `event-agent:${project.id}`;
const unrelatedKey = 'event-agent:cancel-other-project';
let ordinary = createWorkspaceCreationDraft();
let unrelated = createWorkspaceCreationDraft();
function readPersistedDraft(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DRAFT_DATABASE_NAME, WORKSPACE_DRAFT_DATABASE_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(WORKSPACE_DRAFT_STORE_NAME, 'readonly');
      const read = transaction.objectStore(WORKSPACE_DRAFT_STORE_NAME).get(key);
      read.onsuccess = () => resolve(read.result);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error);
    };
  });
}
function CancelEventCreation() {
  return (
    <Routes>
      <Route
        path="/projects/:slug/agents/:id?"
        element={
          <AgentsPage
            project={project}
            renderEventCreation={(onCancel) => (
              <EventAgentWorkspaceForm
                projectId={project.id}
                projectSlug={project.slug}
                onCancel={onCancel}
              />
            )}
          />
        }
      />
      <Route
        path="*"
        element={<Navigate to={`/projects/factory/agents/${event.id}?kind=event`} replace />}
      />
    </Routes>
  );
}
const meta = {
  title: 'Automations/EventAutomationCancel',
  component: CancelEventCreation,
  parameters: {
    trpc: {
      handlers: {
        ...eventWorkspaceHandlers,
        'periodicTask.list': () => [],
        'automation.list': () => ({ items: [eventSummaryFixture(event)], nextCursor: null }),
        'automation.get': () => event,
      },
    },
  },
} satisfies Meta<typeof CancelEventCreation>;
export default meta;
type Story = StoryObj<typeof meta>;
function cancellationStory(failure: boolean, failDelete = false, replaceDraft = false): Story {
  return {
    beforeEach: async () => {
      ordinary = {
        ...createWorkspaceCreationDraft(),
        mode: failure ? 'PERIODIC_TASK' : 'STANDARD',
        prompt: 'Keep ordinary or scheduled instructions',
      };
      unrelated = { ...createWorkspaceCreationDraft(), prompt: 'Keep the other project event' };
      await saveWorkspaceCreationDraft(project.id, ordinary);
      await saveWorkspaceCreationDraft(unrelatedKey, unrelated);
      await saveWorkspaceCreationDraft(eventKey, {
        ...createWorkspaceCreationDraft(),
        prompt: 'Discard this event draft',
      });
    },
    parameters: {
      trpc: {
        handlers: {
          ...meta.parameters.trpc.handlers,
          'workspace.listForProject': () => {
            if (failure) {
              throw new Error('Workspace names unavailable');
            }
            return STORY_TRPC_PENDING;
          },
        },
      },
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await expect(
        await canvas.findByRole('heading', { name: event.name, level: 2 })
      ).toBeVisible();
      await userEvent.click(canvas.getByRole('button', { name: 'Create automation' }));
      await userEvent.click(
        within(canvasElement.ownerDocument.body).getByRole('menuitem', {
          name: 'Event-triggered automation',
        })
      );
      if (failure) {
        await expect(await canvas.findByRole('alert')).toHaveTextContent(
          'Workspace names unavailable'
        );
      } else {
        await expect(await canvas.findByText('Loading workspace names…')).toBeVisible();
      }
      const cancel = canvas.getByRole('button', { name: 'Cancel' });
      await waitFor(() => expect(cancel).toBeEnabled());
      const originalDelete = IDBObjectStore.prototype.delete;
      let failedOnce = false;
      if (failDelete) {
        IDBObjectStore.prototype.delete = function (key) {
          const request = originalDelete.call(this, key);
          if (key === eventKey && !failedOnce) {
            failedOnce = true;
            this.transaction.abort();
          }
          return request;
        };
      }
      try {
        const originalDraft = getWorkspaceCreationDraftSnapshot(eventKey).draft;
        await userEvent.click(cancel);
        if (failDelete) {
          await waitFor(() => expect(failedOnce).toBe(true));
          await waitFor(() => expect(canvas.getByRole('button', { name: 'Cancel' })).toBeEnabled());
          await expect(getWorkspaceCreationDraftSnapshot(eventKey).draft).toBeNull();
          await expect(await readPersistedDraft(eventKey)).toEqual(originalDraft);
          if (replaceDraft) {
            const newer = {
              ...createWorkspaceCreationDraft(),
              prompt: 'Keep the newer event revision',
            };
            await saveWorkspaceCreationDraft(eventKey, newer);
            await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
            await waitFor(() =>
              expect(canvas.getByRole('button', { name: 'Cancel' })).toBeEnabled()
            );
            await expect(getWorkspaceCreationDraftSnapshot(eventKey).draft).toEqual(newer);
            await expect(await readPersistedDraft(eventKey)).toEqual(newer);
          }
          await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
        }
        await expect(
          await canvas.findByRole('heading', { name: event.name, level: 2 })
        ).toBeVisible();
      } finally {
        IDBObjectStore.prototype.delete = originalDelete;
      }
      await expect(canvas.getByRole('link', { name: new RegExp(event.name) })).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(getWorkspaceCreationDraftSnapshot(eventKey).draft).toBeNull();
      await expect(await readPersistedDraft(eventKey)).toBeUndefined();
      await expect(getWorkspaceCreationDraftSnapshot(project.id).draft).toEqual(ordinary);
      await expect(await readPersistedDraft(project.id)).toEqual(ordinary);
      await expect(await readPersistedDraft(unrelatedKey)).toEqual(unrelated);
    },
  };
}
export const NamesLoading: Story = cancellationStory(false);
export const NamesFailure: Story = cancellationStory(true);

export const RetryFailedDelete: Story = cancellationStory(false, true);
export const RetryPreservesNewerRevision: Story = cancellationStory(true, true, true);
