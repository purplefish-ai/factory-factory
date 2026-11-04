import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { z } from 'zod';
import { PRDeliveryMode } from '@/shared/pr-monitoring';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspacePrChip } from './workspace-pr-chip';

type StoryPr = WorkspaceHeaderWorkspace['prs'][number];

const basePr: StoryPr = {
  id: 'pr-42',
  url: 'https://github.com/team/repository/pull/42',
  number: 42,
  title: 'Simplify workspace PR controls',
  headRefName: 'feature/pr-menu',
  baseRefName: 'main',
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
};

/**
 * The chip inside a header-sized container, so the header's container queries
 * apply: wide headers show the status label, narrow ones a status dot.
 */
function PrChipStory({
  deliveryMode = PRDeliveryMode.MAIN,
  enabled = false,
  animated = false,
  archived = false,
  prs = [],
  headerWidth = '64rem',
}: {
  deliveryMode?: PRDeliveryMode;
  enabled?: boolean;
  animated?: boolean;
  archived?: boolean;
  prs?: Partial<StoryPr>[];
  headerWidth?: string;
}) {
  const workspace = {
    id: 'mock-workspace',
    projectId: 'mock-project',
    status: archived ? 'ARCHIVED' : 'READY',
    worktreePath: '/tmp/workspace',
    ratchetState: animated ? 'CI_RUNNING' : 'IDLE',
    ratchetEnabled: enabled,
    ratchetButtonAnimated: animated,
    prs: prs.map((pr, index) => ({ ...basePr, id: `pr-${index}`, ...pr })),
    prMonitoring: {
      deliveryMode,
      enabled,
      recipientSessionId: null,
      bindingRevision: 1,
      pauseReason: null,
      pendingEventCount: 0,
    },
  } as WorkspaceHeaderWorkspace;
  return (
    <div
      className="@container/header flex max-w-full justify-end border-b p-2"
      style={{ width: headerWidth }}
    >
      <WorkspacePrChip workspace={workspace} workspaceId={workspace.id} />
    </div>
  );
}

const meta = {
  title: 'Workspace/WorkspacePrChip',
  component: PrChipStory,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The workspace header PR control. It shows "#123" with the state that most needs attention, in the shared status tones, and the wrench shows whether PR updates are on. The menu lists every PR and holds the updates toggle, delivery options and Add PR.',
      },
    },
    trpc: {
      handlers: {
        // Turning updates on in the main conversation asks which chat receives them.
        'workspace.toggleRatcheting': (input: unknown) => {
          const { recipientSessionId, deliveryMode } = z
            .object({
              recipientSessionId: z.string().nullable().optional(),
              deliveryMode: z.string().optional(),
            })
            .parse(input);
          return recipientSessionId || deliveryMode === PRDeliveryMode.DEDICATED
            ? { status: 'enabled' }
            : {
                status: 'recipient_required',
                bindingRevision: 1,
                candidates: [
                  { id: 'main', name: 'Implementation', provider: 'claude' },
                  { id: 'other', name: 'Follow-up', provider: 'codex' },
                ],
              };
        },
      },
    },
  },
} satisfies Meta<typeof PrChipStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const chip = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('button', { name: /^Pull requests and updates/ });

export const NoPullRequest: Story = {
  play: async ({ canvasElement }) => {
    await expect(chip(canvasElement)).toHaveAccessibleName(
      'Pull requests and updates: no PR, updates off'
    );
    await expect(within(canvasElement).getByText('No PR')).toBeVisible();
  },
};
export const CiPassing: Story = {
  args: { enabled: true, prs: [{}] },
  play: async ({ canvasElement }) => {
    await expect(chip(canvasElement)).toHaveAccessibleName(
      'Pull requests and updates: #42 CI Passing, updates on (Watching)'
    );
    await expect(within(canvasElement).getByText('CI Passing')).toBeVisible();
  },
};
export const CiRunning: Story = {
  args: { enabled: true, animated: true, prs: [{ ciStatus: 'PENDING' }] },
};
export const CiFailing: Story = { args: { enabled: true, prs: [{ ciStatus: 'FAILURE' }] } };
export const ChangesRequested: Story = { args: { prs: [{ state: 'CHANGES_REQUESTED' }] } };
export const Approved: Story = { args: { prs: [{ state: 'APPROVED' }] } };
export const Draft: Story = { args: { prs: [{ state: 'DRAFT', ciStatus: 'UNKNOWN' }] } };
export const MergeConflict: Story = { args: { prs: [{ hasMergeConflict: true }] } };
export const Merged: Story = { args: { prs: [{ state: 'MERGED' }] } };
export const MergedDark: Story = {
  args: { prs: [{ state: 'MERGED' }] },
  globals: { theme: 'dark' },
};
export const CiFailingDark: Story = {
  args: { enabled: true, prs: [{ ciStatus: 'FAILURE' }] },
  globals: { theme: 'dark' },
};
export const Archived: Story = { args: { archived: true, prs: [{ state: 'MERGED' }] } };

/** Below the header's 48rem breakpoint the label collapses to a status dot. */
export const PhoneCompact: Story = {
  args: { enabled: true, prs: [{ ciStatus: 'FAILURE' }], headerWidth: '22rem' },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(chip(canvasElement)).toHaveAccessibleName(
      'Pull requests and updates: #42 CI Failing, updates on (Watching)'
    );
    await expect(within(canvasElement).getByText('#42')).toBeVisible();
    await expect(within(canvasElement).getByText('CI Failing')).not.toBeVisible();
  },
};

export const PhoneRecipientSelection: Story = {
  args: { headerWidth: '22rem' },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const DedicatedDestination: Story = {
  args: { deliveryMode: PRDeliveryMode.DEDICATED, enabled: true, prs: [{}] },
};

export const MultiplePullRequests: Story = {
  args: {
    prs: [{}, { number: 43, title: 'Previous workspace change', state: 'CLOSED' }],
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('+1')).toBeVisible();
    await userEvent.click(chip(canvasElement));
    const menu = within(canvasElement.ownerDocument.body).getByRole('menu');
    await waitFor(async () => {
      await expect(within(menu).getByText('#42 · Simplify workspace PR controls')).toBeVisible();
    });
    await expect(within(menu).getByText('#43 · Previous workspace change')).toBeVisible();
    await expect(within(menu).getByText('Closed')).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: /Turn on PR updates/ })).toBeVisible();
  },
};
