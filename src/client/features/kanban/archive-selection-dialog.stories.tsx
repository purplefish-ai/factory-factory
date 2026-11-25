import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { ArchiveSelectionDialog } from './archive-selection-dialog';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';

const dirty: WorkspaceWithKanban = {
  ...baseWorkspace,
  id: 'ws-dirty',
  name: 'Unsaved refactor',
  gitStats: { total: 12, additions: 10, deletions: 2, hasUncommitted: true },
};

const clean: WorkspaceWithKanban = { ...baseWorkspace, id: 'ws-clean', name: 'Clean work' };

const archiveIncomplete: WorkspaceWithKanban = {
  ...baseWorkspace,
  id: 'ws-incomplete',
  name: 'Archive left incomplete',
  status: 'FAILED',
  initErrorMessage:
    'Archive incomplete: Failed to delete worktree: worktree is locked. Archive again to finish.',
  // Stale stats from before the first archive; they must not read as a risk.
  gitStats: { total: 3, additions: 3, deletions: 0, hasUncommitted: true },
  statusReason: {
    code: 'ARCHIVE_INCOMPLETE',
    label: 'Archive incomplete',
    tone: 'danger',
    needsUser: true,
  },
};

const meta = {
  title: 'Board/ArchiveSelectionDialog',
  component: ArchiveSelectionDialog,
  parameters: { layout: 'centered' },
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    workspaces: [dirty, clean],
  },
} satisfies Meta<typeof ArchiveSelectionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ordinary archives commit uncommitted changes and flag them. */
export const Default: Story = {
  play: async () => {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent(
      'Uncommitted changes will be committed before the worktrees are removed.'
    );
    await expect(dialog).toHaveTextContent('Uncommitted changes (1): Unsaved refactor');
  },
};

/** Archiving again after an archive that stopped partway does not commit again. */
export const ArchiveIncomplete: Story = {
  args: { workspaces: [archiveIncomplete] },
  play: async () => {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Its last archive stopped partway');
    await expect(dialog).toHaveTextContent('so nothing is committed again.');
    await expect(dialog).not.toHaveTextContent('will be committed');
    await expect(dialog).not.toHaveTextContent('Check before archiving');
  },
};

/** A mixed selection names the workspaces that are only finishing an earlier archive. */
export const MixedWithArchiveIncomplete: Story = {
  args: { workspaces: [dirty, archiveIncomplete] },
  play: async () => {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('nothing is committed again for it.');
    await expect(dialog).toHaveTextContent('Archive incomplete (1): Archive left incomplete');
    await expect(dialog).toHaveTextContent('Uncommitted changes (1): Unsaved refactor');
  },
};

export const MixedWithArchiveIncompleteDark: Story = {
  ...MixedWithArchiveIncomplete,
  globals: { theme: 'dark' },
};

export const MixedWithArchiveIncompletePhone: Story = {
  ...MixedWithArchiveIncomplete,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
