import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent } from 'storybook/test';
import { Calendar } from './calendar';

const meta = {
  title: 'UI/Calendar',
  component: Calendar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Calendar>;
export default meta;
type Story = StoryObj<typeof meta>;

function SelectableCalendar({ dropdown = false }: { dropdown?: boolean }) {
  const [selected, setSelected] = useState<Date | undefined>(new Date(2026, 8, 9));
  return (
    <Calendar
      mode="single"
      selected={selected}
      onSelect={setSelected}
      defaultMonth={new Date(2026, 8)}
      captionLayout={dropdown ? 'dropdown' : 'label'}
      startMonth={new Date(2025, 0)}
      endMonth={new Date(2027, 11)}
      disabled={new Date(2026, 8, 10)}
    />
  );
}
export const SingleDate: Story = { render: () => <SelectableCalendar /> };
export const DropdownCaption: Story = { render: () => <SelectableCalendar dropdown /> };

export const SelectedDateHover: Story = {
  ...SingleDate,
  play: async ({ canvasElement }) => {
    const selected = canvasElement.querySelector('[data-selected-single="true"]');
    if (!(selected instanceof HTMLButtonElement)) {
      throw new Error('Expected a selected calendar day');
    }
    await expect(selected).toHaveAttribute('data-variant', 'default');
    await userEvent.hover(selected);
  },
};
export const SelectedDateHoverDark: Story = {
  ...SelectedDateHover,
  globals: { theme: 'dark' },
};
