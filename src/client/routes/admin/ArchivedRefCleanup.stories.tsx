import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { STORY_TRPC_PENDING, StoryTrpcProvider } from '@/client/lib/storybook-trpc';
import { ArchivedRefCleanup } from './ArchivedRefCleanup';

const onRequest = fn<(path: string, input: unknown) => void>();

const OLD = new Date('2026-09-14T10:00:00Z');

type Tier = 'REDUNDANT' | 'UNIQUE_WORK';
const archive = (id: string, name: string | null, sha: string, tier: Tier, commits = 0) => ({
  ref: `refs/factory-factory/archive/${id}`,
  sha: sha.repeat(40),
  kind: 'ARCHIVE' as const,
  tier,
  workspaceId: id,
  workspaceName: name,
  branchName: null,
  unsharedCommits: commits,
  datedAt: OLD,
});
const pin = (branch: string, sha: string, tier: Tier, commits = 0) => ({
  ref: `refs/factory-factory/deleted-branches/${branch.replaceAll('/', '_2F')}/${sha.repeat(40)}`,
  sha: sha.repeat(40),
  kind: 'DELETED_BRANCH' as const,
  tier,
  workspaceId: null,
  workspaceName: null,
  branchName: branch,
  unsharedCommits: commits,
  datedAt: OLD,
});

const sampleGroups = () => [
  {
    projectId: 'project-1',
    projectNames: ['factory-factory'],
    repoPath: '/Users/me/code/factory-factory',
    refs: [
      archive('cmw1', 'Add branch cleanup', 'a', 'REDUNDANT'),
      archive('cmw2', 'Fix kanban drag', 'b', 'REDUNDANT'),
      pin('me/session-resume-cursor', 'c', 'REDUNDANT'),
      archive(
        'cmw3',
        'Try a new board layout with a very long workspace name',
        'd',
        'UNIQUE_WORK',
        4
      ),
      archive('cmw4', null, 'e', 'UNIQUE_WORK', 1),
    ],
  },
  {
    projectId: 'project-2',
    projectNames: ['website'],
    repoPath: '/Users/me/code/website',
    refs: [pin('me/pricing-page.v2', 'f', 'UNIQUE_WORK', 2)],
  },
];

type Mode = 'populated' | 'redundant-only' | 'empty' | 'loading' | 'scan-error' | 'partial-failure';

function CleanupStory({ mode }: { mode: Mode }) {
  const [handlers] = useState(() => {
    let groups =
      mode === 'empty'
        ? []
        : mode === 'redundant-only'
          ? sampleGroups().map((group) => ({
              ...group,
              refs: group.refs.filter((ref) => ref.tier === 'REDUNDANT'),
            }))
          : sampleGroups();
    return {
      'admin.listArchivedRefCandidates': () => {
        if (mode === 'loading') {
          return STORY_TRPC_PENDING;
        }
        if (mode === 'scan-error') {
          throw new Error('fatal: not a git repository: /Users/me/code/website');
        }
        return groups;
      },
      'admin.removeArchivedRefs': (input: unknown) => {
        const { refs } = input as { refs: Array<{ projectId: string; ref: string }> };
        const items = refs.map(({ projectId, ref }) => ({ projectId, ref }));
        // In partial-failure mode the first ref fails and stays listed, as with the real service.
        const [first, ...rest] = items;
        const failed =
          mode === 'partial-failure' && first
            ? [{ ...first, error: "cannot lock ref 'refs/factory-factory/x'" }]
            : [];
        const removed = failed.length > 0 ? rest : items;
        const removedRefs = new Set(removed.map((item) => item.ref));
        groups = groups.map((group) => ({
          ...group,
          refs: group.refs.filter((ref) => !removedRefs.has(ref.ref)),
        }));
        return { removed, skipped: [], failed };
      },
    };
  });
  return (
    <StoryTrpcProvider handlers={handlers} onRequest={onRequest}>
      <div className="mx-auto w-full max-w-3xl rounded-xl border p-6">
        <ArchivedRefCleanup />
      </div>
    </StoryTrpcProvider>
  );
}

const meta = {
  title: 'Settings/ArchivedRefCleanup',
  component: ArchivedRefCleanup,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  beforeEach: () => {
    onRequest.mockClear();
    toast.dismiss();
  },
} satisfies Meta<typeof ArchivedRefCleanup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  render: () => <CleanupStory mode="populated" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('3 snapshots holding work found nowhere else');
    await expect(canvas.getByRole('button', { name: 'Delete 3 snapshots' })).toBeEnabled();
    await expect(canvas.getByText('4 commits found nowhere else', { exact: false })).toBeVisible();
  },
};

export const DeleteRedundantAfterConfirmation: Story = {
  render: () => <CleanupStory mode="redundant-only" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete 3 snapshots' }));
    const dialog = within(document.body);
    await dialog.findByText('Delete 3 snapshots?');
    await expect(onRequest).not.toHaveBeenCalledWith('admin.removeArchivedRefs', expect.anything());
    await userEvent.click(await dialog.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith(
        'admin.removeArchivedRefs',
        expect.objectContaining({
          refs: expect.arrayContaining([
            expect.objectContaining({
              ref: 'refs/factory-factory/archive/cmw1',
              tier: 'REDUNDANT',
            }),
          ]),
        })
      )
    );
    await canvas.findByText('No archive snapshots to delete.');
    await dialog.findByText('Deleted 3 snapshots.');
  },
};

export const ChooseUniqueWork: Story = {
  render: () => <CleanupStory mode="populated" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('checkbox', { name: /Snapshot of deleted workspace cmw4/ })
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Delete 4 snapshots' }));
    const dialog = within(document.body);
    await dialog.findByText(/1 of them holds work found on no branch or remote/);
  },
};

export const PartialFailure: Story = {
  render: () => <CleanupStory mode="partial-failure" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete 3 snapshots' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Delete' }));
    await within(document.body).findByText(
      "Couldn't delete all snapshots. Deleted 2; failed to delete 1."
    );
    await within(document.body).findByText("cannot lock ref 'refs/factory-factory/x'");
    // The ref that failed is still listed after the refresh.
    await canvas.findByRole('button', { name: 'Delete 1 snapshot' });
    await expect(canvas.getByText('Snapshot of Add branch cleanup')).toBeVisible();
  },
};

export const Empty: Story = {
  render: () => <CleanupStory mode="empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('No archive snapshots to delete.');
    await expect(canvas.getByRole('button', { name: 'Delete snapshots' })).toBeDisabled();
  },
};

export const Loading: Story = {
  render: () => <CleanupStory mode="loading" />,
};

export const ScanError: Story = {
  render: () => <CleanupStory mode="scan-error" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Couldn't scan for archive snapshots");
  },
};

export const Phone: Story = {
  render: () => <CleanupStory mode="populated" />,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
