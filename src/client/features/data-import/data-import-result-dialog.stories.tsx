import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { DataImportResultDialog } from './data-import-result-dialog';

const meta = {
  title: 'Features/DataImport/RecoveryResults',
  component: DataImportResultDialog,
  args: { onClose: () => undefined },
} satisfies Meta<typeof DataImportResultDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SkippedHistory: Story = {
  args: {
    report: {
      models: [
        { model: 'PeriodicTask', imported: 0, skipped: 1 },
        { model: 'PeriodicTaskExecution', imported: 0, skipped: 1 },
        { model: 'ClosedSession', imported: 2, skipped: 0 },
      ],
      skipped: [
        { model: 'PeriodicTask', identity: 'daily-review', reason: 'EXISTING_IDENTITY' },
        {
          model: 'PeriodicTaskExecution',
          identity: 'retained-run',
          reason: 'CONFLICTING_IDENTITY_OR_PARENT',
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(screen.getByRole('alertdialog')).toBeVisible();
    });
    await expect(screen.getByText('Recovery import results')).toBeVisible();
    await expect(screen.getByText(/identity already exists/)).toBeVisible();
    await expect(screen.getByText(/conflicting unique identity or skipped parent/)).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Download full report' })).toBeVisible();
  },
};

export const SingleSkippedRecord: Story = {
  args: {
    report: {
      models: [{ model: 'ClosedSession', imported: 0, skipped: 1 }],
      skipped: [
        { model: 'ClosedSession', identity: 'saved-conversation', reason: 'EXISTING_IDENTITY' },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(
        screen.getByText(
          '1 retained record was skipped. The full report contains every skipped identity.'
        )
      ).toBeVisible();
    });
    await expect(screen.getByRole('button', { name: 'Download full report' })).toBeVisible();
  },
};
