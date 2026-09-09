import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from './button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './sheet';
import { Slider } from './slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const meta = {
  title: 'UI/Primitives Accessibility',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const insetCases = [
  { label: 'Default', inset: undefined, padding: '8px' },
  { label: 'Not inset', inset: false, padding: '8px' },
  { label: 'Inset', inset: true, padding: '32px' },
];

async function checkMenuPadding(menu: HTMLElement) {
  const rows = within(menu);
  for (const { label, padding } of insetCases) {
    for (const kind of ['label', 'item', 'submenu']) {
      await expect(getComputedStyle(rows.getByText(`${label} ${kind}`)).paddingLeft).toBe(padding);
    }
  }
}

export const DropdownInsets: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>Menu padding</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {insetCases.map(({ label, inset }) => (
          <DropdownMenuLabel key={label} inset={inset}>
            {label} label
          </DropdownMenuLabel>
        ))}
        {insetCases.map(({ label, inset }) => (
          <DropdownMenuItem key={label} inset={inset}>
            {label} item
          </DropdownMenuItem>
        ))}
        {insetCases.map(({ label, inset }) => (
          <DropdownMenuSub key={label}>
            <DropdownMenuSubTrigger inset={inset}>{label} submenu</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Menu padding' }));
    await checkMenuPadding(await within(canvasElement.ownerDocument.body).findByRole('menu'));
  },
};

export const ContextInsets: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="block w-64 rounded border p-4">
        Right-click for menu padding
      </ContextMenuTrigger>
      <ContextMenuContent>
        {insetCases.map(({ label, inset }) => (
          <ContextMenuLabel key={label} inset={inset}>
            {label} label
          </ContextMenuLabel>
        ))}
        {insetCases.map(({ label, inset }) => (
          <ContextMenuItem key={label} inset={inset}>
            {label} item
          </ContextMenuItem>
        ))}
        {insetCases.map(({ label, inset }) => (
          <ContextMenuSub key={label}>
            <ContextMenuSubTrigger inset={inset}>{label} submenu</ContextMenuSubTrigger>
          </ContextMenuSub>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  ),
  play: async ({ canvas, canvasElement }) => {
    await userEvent.pointer({
      target: canvas.getByText('Right-click for menu padding'),
      keys: '[MouseRight]',
    });
    await checkMenuPadding(await within(canvasElement.ownerDocument.body).findByRole('menu'));
  },
};

export const KeyboardFocus: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="max-w-sm p-4">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">Workspace overview</TabsContent>
    </Tabs>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('tab'));
    await userEvent.tab();
    const panel = canvas.getByRole('tabpanel');
    await expect(panel).toHaveFocus();
    await expect(getComputedStyle(panel).boxShadow).not.toBe('none');
    await expect(panel.matches(':focus-visible')).toBe(true);
  },
};

export const ThemedSlider: Story = {
  render: () => <Slider defaultValue={[50]} className="m-4 max-w-sm" aria-label="Volume" />,
  play: async ({ canvas, canvasElement }) => {
    const thumb = canvas.getByRole('slider');
    const sample = canvasElement.ownerDocument.createElement('span');
    sample.style.backgroundColor = 'var(--background)';
    thumb.after(sample);
    try {
      await expect(getComputedStyle(thumb).backgroundColor).toBe(
        getComputedStyle(sample).backgroundColor
      );
    } finally {
      sample.remove();
    }
  },
};

export const SheetHeading: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetTitle>Workspace settings</SheetTitle>
        <SheetDescription>Configure your workspace.</SheetDescription>
      </SheetContent>
    </Sheet>
  ),
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Open sheet' }));
    const title = await within(canvasElement.ownerDocument.body).findByRole('heading', {
      name: 'Workspace settings',
    });
    await expect(getComputedStyle(title).fontSize).toBe('18px');
  },
};
