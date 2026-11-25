import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { z } from 'zod';
import type { StoryTrpcHandler } from '@/client/lib/storybook-trpc';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { KanbanBoard } from './kanban-board';
import { handlers, kanbanBoardMeta } from './kanban-board.provider.story-fixtures';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

function waiting(id: string, name: string, minutesAgo: number): WorkspaceWithKanban {
  return {
    ...baseWorkspace,
    id,
    name,
    kanbanColumn: 'WAITING',
    branchName: null,
    lastActivityAt: new Date(Date.UTC(2026, 10, 20, 12, 60 - minutesAgo)).toISOString(),
  };
}

const boardWorkspaces: WorkspaceWithKanban[] = [
  {
    ...baseWorkspace,
    id: 'sel-working',
    name: 'Agent still running',
    kanbanColumn: 'WORKING',
    isWorking: true,
  },
  waiting('sel-a', 'Waiting task A', 1),
  {
    ...waiting('sel-b', 'Waiting task B', 2),
    gitStats: { total: 12, additions: 10, deletions: 2, hasUncommitted: true },
  },
  {
    ...waiting('sel-c', 'Waiting task C', 3),
    prSummary: { ...deriveWorkspacePRSummary([], true), openCount: 1 },
  },
  waiting('sel-d', 'Waiting task D', 4),
  { ...baseWorkspace, id: 'sel-done', name: 'Merged work', kanbanColumn: 'DONE' },
];

const archiveManyInput = z.object({ ids: z.array(z.string()) });

// Archived workspaces leave the list until the next story starts.
const archived = new Set<string>();

/** A small server: archived workspaces leave the list; `failing` IDs fail to archive. */
function selectionStory(failing: ReadonlySet<string> = new Set()) {
  return {
    beforeEach: () => archived.clear(),
    parameters: { trpc: { handlers: selectionHandlers(failing) } },
  };
}

function selectionHandlers(failing: ReadonlySet<string>) {
  const archiveMany: StoryTrpcHandler = (input) => {
    const { ids } = archiveManyInput.parse(input);
    const results = ids.map((id) => {
      if (failing.has(id)) {
        return {
          id,
          success: false,
          error: 'Worktree removal failed',
          code: 'INTERNAL_SERVER_ERROR',
          applicationErrorKind: null,
        };
      }
      archived.add(id);
      return { id, success: true };
    });
    return { results, total: ids.length };
  };
  return {
    ...handlers,
    'workspace.listForProject': () => ({
      workspaces: boardWorkspaces.filter(({ id }) => !archived.has(id)),
      reviewCount: 0,
    }),
    'workspace.archiveMany': archiveMany,
  };
}

type PlayContext = Parameters<NonNullable<Story['play']>>[0];

/** Enters selection mode and selects Waiting B, C and D. */
async function selectWaitingCards({ canvasElement }: PlayContext) {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);
  await canvas.findByText('Waiting task A');
  // Nothing hints at selection until the mode is entered.
  await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0);

  await userEvent.click(canvas.getByRole('button', { name: 'Board actions' }));
  await userEvent.click(await body.findByRole('menuitem', { name: 'Select workspaces' }));
  const status = within(canvas.getByRole('region', { name: 'Workspace selection' })).getByText(
    /selected/
  );
  await expect(status).toHaveTextContent('0 selected');
  await waitFor(() =>
    expect(canvasElement.ownerDocument.activeElement).toHaveAccessibleName(
      'Select Agent still running'
    )
  );

  await userEvent.click(canvas.getByRole('checkbox', { name: 'Select all in Waiting' }));
  await expect(status).toHaveTextContent('4 selected');
  await userEvent.click(canvas.getByText('Waiting task A'));
  await expect(canvas.getByRole('checkbox', { name: 'Select Waiting task A' })).not.toBeChecked();
  await expect(canvas.getByRole('checkbox', { name: 'Select all in Waiting' })).toHaveAttribute(
    'aria-checked',
    'mixed'
  );
  await expect(status).toHaveTextContent('3 selected');
}

async function openArchiveConfirm(context: PlayContext) {
  await selectWaitingCards(context);
  return confirmSelection(context);
}

async function confirmSelection(context: PlayContext) {
  const canvas = within(context.canvasElement);
  await userEvent.click(
    within(canvas.getByRole('region', { name: 'Workspace selection' })).getByRole('button', {
      name: 'Archive',
    })
  );
  const dialog = await within(context.canvasElement.ownerDocument.body).findByRole('alertdialog');
  await expect(dialog).toHaveTextContent('Archive 3 workspaces?');
  await expect(dialog).toHaveTextContent('Uncommitted changes (1): Waiting task B');
  await expect(dialog).toHaveTextContent('Open pull request (1): Waiting task C');
  await expect(dialog).not.toHaveTextContent('Agent running');
  return dialog;
}

/** The confirm dialog counts the selection and flags what archiving could lose. */
export const SelectionArchiveConfirm: Story = {
  ...selectionStory(),
  play: async (context) => {
    await openArchiveConfirm(context);
  },
};

/** Archiving the selection removes those cards and leaves selection mode. */
export const SelectionArchive: Story = {
  ...selectionStory(),
  play: async (context) => {
    const dialog = await openArchiveConfirm(context);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive 3' }));
    const canvas = within(context.canvasElement);
    await waitFor(() => expect(canvas.queryByText('Waiting task B')).not.toBeInTheDocument());
    await expect(canvas.queryByText('Waiting task C')).not.toBeInTheDocument();
    await expect(canvas.queryByText('Waiting task D')).not.toBeInTheDocument();
    await expect(canvas.getByText('Waiting task A')).toBeVisible();
    await waitFor(() =>
      expect(canvas.queryByRole('region', { name: 'Workspace selection' })).not.toBeInTheDocument()
    );
    await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0);
  },
};

/** A failed archive brings its card back, still selected, and names it in a toast. */
export const SelectionArchivePartialFailure: Story = {
  ...selectionStory(new Set(['sel-c'])),
  play: async (context) => {
    const dialog = await openArchiveConfirm(context);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive 3' }));
    const canvas = within(context.canvasElement);
    const body = within(context.canvasElement.ownerDocument.body);
    await expect(
      await body.findByText("Couldn't archive Waiting task C. Worktree removal failed.")
    ).toBeVisible();
    await waitFor(() => expect(canvas.queryByText('Waiting task B')).not.toBeInTheDocument());
    await expect(canvas.getByRole('checkbox', { name: 'Select Waiting task C' })).toBeChecked();
    await expect(
      within(canvas.getByRole('region', { name: 'Workspace selection' })).getByText(/selected/)
    ).toHaveTextContent('1 selected');
  },
};

/** The stacked phone board keeps the action bar under the sections. */
export const PhoneSelectionArchive: Story = {
  ...SelectionArchive,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async (context) => {
    await SelectionArchive.play?.(context);
  },
};

export const PhoneSelectionArchiveConfirm: Story = {
  ...SelectionArchiveConfirm,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async (context) => {
    await selectWaitingCards(context);
    const bar = within(context.canvasElement).getByRole('region', {
      name: 'Workspace selection',
    });
    const bounds = bar.getBoundingClientRect();
    await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    await expect(bounds.width).toBeGreaterThan(0);
    await confirmSelection(context);
  },
};
