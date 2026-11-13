import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import type { KanbanBoard } from './kanban-board';
import { kanbanBoardMeta } from './kanban-board.provider.story-fixtures';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FilterOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Add authentication');
    await expect(
      canvas.queryByRole('combobox', { name: 'Sort workspaces' })
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox', { name: /^Select / })).not.toBeInTheDocument();
    const filter = within(canvas.getByRole('banner')).getByRole('textbox', {
      name: 'Filter board',
    });
    await userEvent.type(filter, 'authentication');
    await expect(canvas.getByText('Add authentication')).toBeVisible();
    await expect(canvas.queryByText('Fix login bug')).not.toBeInTheDocument();
    await userEvent.clear(filter);
    await userEvent.type(filter, 'keyboard');
    await expect(canvas.getByText('Support keyboard shortcuts on the board')).toBeVisible();
    await expect(canvas.queryByText('Add authentication')).not.toBeInTheDocument();
    await userEvent.clear(filter);
    await expect(canvas.getByText('Add authentication')).toBeVisible();
  },
};

export const PhoneFilter: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const filter = canvas.getByRole('textbox', {
      name: 'Filter board',
    });
    await expect(filter).toBeVisible();
    await userEvent.type(filter, 'no matching task');
    await expect(canvas.getByText('No matching issues or workspaces')).toBeVisible();
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Filter board' }));
    await expect(canvas.getByText('Update dependencies')).toBeVisible();
  },
};

export const PhoneFilterAcrossColumns: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const filter = canvas.getByRole('textbox', { name: 'Filter board' });
    await userEvent.type(filter, 'fix');
    await expect(await canvas.findByText('Fix login bug')).toBeVisible();
    await expect(canvas.getByText('Fix typo')).toBeVisible();
    await expect(canvas.queryByText('Update dependencies')).not.toBeInTheDocument();
    await expect(canvas.getByRole('heading', { name: 'Working' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Done' })).toBeVisible();
    await userEvent.clear(filter);
    await expect(await canvas.findByText('Update dependencies')).toBeVisible();
    await expect(canvas.getByText('Fix login bug')).toBeInTheDocument();
  },
};
