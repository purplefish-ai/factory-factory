import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { STORY_TRPC_PENDING, StoryTrpcProvider } from '@/client/lib/storybook-trpc';
import { ArchivedBranchCleanupSection } from './ArchivedBranchCleanupSection';

const onRequest = fn<(path: string, input: unknown) => void>();

type Safety = 'ON_REMOTE' | 'MERGED_PR';
const branch = (name: string, sha: string, safeBecause: Safety) => ({
  name,
  sha: sha.repeat(40),
  safeBecause,
});
const sampleGroups = () => [
  {
    projectId: 'project-1',
    projectNames: ['factory-factory'],
    repoPath: '/Users/me/code/factory-factory',
    branches: [
      branch('me/add-branch-cleanup', 'a', 'MERGED_PR'),
      branch('me/fix-kanban-drag', 'b', 'ON_REMOTE'),
      branch('me/session-resume-cursor', 'c', 'MERGED_PR'),
    ],
  },
  {
    projectId: 'project-2',
    projectNames: ['website', 'website (docs)'],
    repoPath: '/Users/me/code/website',
    branches: [branch('me/pricing-page.v2', 'd', 'ON_REMOTE')],
  },
];

type Mode = 'populated' | 'empty' | 'loading' | 'scan-error' | 'partial-failure';

function CleanupStory({ mode }: { mode: Mode }) {
  const [handlers] = useState(() => {
    let groups = mode === 'empty' ? [] : sampleGroups();
    return {
      // The snapshot list's own states are in ArchivedRefCleanup.stories.tsx.
      'admin.listArchivedRefCandidates': () => (mode === 'loading' ? STORY_TRPC_PENDING : []),
      'admin.listArchivedBranchCandidates': () => {
        if (mode === 'loading') {
          return STORY_TRPC_PENDING;
        }
        if (mode === 'scan-error') {
          throw new Error('fatal: not a git repository: /Users/me/code/website');
        }
        return groups;
      },
      'admin.removeArchivedBranches': () => {
        const items = groups.flatMap((group) =>
          group.branches.map((b) => ({ projectId: group.projectId, name: b.name }))
        );
        groups = [];
        if (mode === 'partial-failure') {
          const [first, ...rest] = items;
          return {
            removed: rest.map((item) => ({ ...item, pinRef: 'refs/factory-factory/x' })),
            skipped: [],
            failed: first ? [{ ...first, error: "cannot lock ref 'refs/heads/x'" }] : [],
          };
        }
        return {
          removed: items.map((item) => ({ ...item, pinRef: 'refs/factory-factory/x' })),
          skipped: [],
          failed: [],
        };
      },
    };
  });
  return (
    <StoryTrpcProvider handlers={handlers} onRequest={onRequest}>
      <div className="mx-auto w-full max-w-3xl">
        <ArchivedBranchCleanupSection />
      </div>
    </StoryTrpcProvider>
  );
}

const meta = {
  title: 'Settings/ArchivedBranchCleanupSection',
  component: ArchivedBranchCleanupSection,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  beforeEach: () => {
    onRequest.mockClear();
    toast.dismiss();
  },
} satisfies Meta<typeof ArchivedBranchCleanupSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  render: () => <CleanupStory mode="populated" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Found 4 branches from archived workspaces.');
    await expect(canvas.getByText('me/pricing-page.v2')).toBeVisible();
  },
};

export const DeleteAfterConfirmation: Story = {
  render: () => <CleanupStory mode="populated" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete 4 branches' }));
    const dialog = within(document.body);
    await dialog.findByText('Delete 4 branches?');
    await expect(onRequest).not.toHaveBeenCalledWith(
      'admin.removeArchivedBranches',
      expect.anything()
    );
    await userEvent.click(await dialog.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith(
        'admin.removeArchivedBranches',
        expect.objectContaining({
          branches: expect.arrayContaining([
            { projectId: 'project-2', name: 'me/pricing-page.v2', sha: 'd'.repeat(40) },
          ]),
        })
      )
    );
    await canvas.findByText('No archived workspace branches to delete.');
    await dialog.findByText('Deleted 4 branches.');
  },
};

export const PartialFailure: Story = {
  render: () => <CleanupStory mode="partial-failure" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete 4 branches' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Delete' }));
    await within(document.body).findByText(
      "Couldn't delete all branches. Deleted 3; failed to delete 1. cannot lock ref 'refs/heads/x'"
    );
  },
};

export const Empty: Story = {
  render: () => <CleanupStory mode="empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('No archived workspace branches to delete.');
    await expect(canvas.getByRole('button', { name: 'Delete branches' })).toBeDisabled();
  },
};

export const Loading: Story = {
  render: () => <CleanupStory mode="loading" />,
};

export const ScanError: Story = {
  render: () => <CleanupStory mode="scan-error" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Couldn't scan for archived workspace branches");
  },
};

export const Phone: Story = {
  render: () => <CleanupStory mode="populated" />,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
