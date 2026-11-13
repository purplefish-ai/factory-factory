import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';
import { workspaceHeaderMeta } from './workspace-header-fixture.story-fixtures';

const meta = {
  ...workspaceHeaderMeta,
  title: 'Navigation/AppHeader',
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

const openMoreActions = async (
  canvasElement: HTMLElement,
  expected: string[] = ALWAYS_IN_MORE_ACTIONS
) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
  const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
  for (const name of expected) {
    await within(menu).findByRole('menuitem', { name });
  }
  return [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
};
const ALWAYS_IN_MORE_ACTIONS = [
  'View details',
  'Rename workspace',
  'Provider settings',
  'Open branch on GitHub',
  'Open dev app',
  'Open in VS Code',
  'Archive workspace',
];

/** At desktop widths the menu skips what the header already shows inline. */
export const DesktopMoreActions: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      await canvas.findByRole('button', { name: /^Pull requests and updates: #2643 Merged/ })
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Create PR' })).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Archive workspace', hidden: true })
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('button', { name: 'Open in VS Code', hidden: true })
    ).not.toBeInTheDocument();
    const items = await openMoreActions(canvasElement);
    for (const name of ALWAYS_IN_MORE_ACTIONS) {
      await expect(items).toContain(name);
    }
    for (const inline of ['Create PR', '#3456']) {
      await expect(items).not.toContain(inline);
    }
  },
};

/** On a phone, controls hidden from the header row move into the menu. */
export const PhoneMoreActions: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      await canvas.findByRole('button', { name: /^Pull requests and updates/ })
    ).toBeVisible();
    const items = await openMoreActions(canvasElement, [
      ...ALWAYS_IN_MORE_ACTIONS,
      'Create PR',
      '#3456',
    ]);
    for (const name of [...ALWAYS_IN_MORE_ACTIONS, 'Create PR', '#3456']) {
      await expect(items).toContain(name);
    }
  },
};

export const PendingActions: Story = {
  args: { pendingActions: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole('button', { name: /Open(ing)? in VS Code/, hidden: true })
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole('menuitem', { name: 'Archiving…' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(await body.findByRole('menuitem', { name: 'Open in VS Code' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await canvas.findByRole('button', { name: /Stop dev server/ }));
    await expect(
      await canvas.findByRole('button', { name: 'Stopping dev server…' })
    ).toBeDisabled();
  },
};
export const PendingActionsDark: Story = { ...PendingActions, globals: { theme: 'dark' } };

function ChangingPendingActions() {
  const [pendingActions, setPendingActions] = useState(false);
  return (
    <>
      <Button onClick={() => setPendingActions(true)}>Preview pending actions</Button>
      <WorkspaceHeaderFixture pendingActions={pendingActions} />
    </>
  );
}

export const PendingActionsAfterUpdate: Story = {
  render: () => <ChangingPendingActions />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: /Stop dev server/ });
    await userEvent.click(canvas.getByRole('button', { name: 'Preview pending actions' }));
    await userEvent.click(canvas.getByRole('button', { name: /Stop dev server/ }));
    await expect(
      await canvas.findByRole('button', { name: 'Stopping dev server…' })
    ).toBeDisabled();
  },
};
