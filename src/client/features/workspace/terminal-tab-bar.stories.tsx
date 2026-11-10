import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StatusDot } from '@/client/components/status-indicators';
import { TabButton } from '@/components/ui/tab-button';
import { TerminalControls } from './right-panel';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';
import { TerminalTabBar } from './terminal-tab-bar';

const meta: Meta<typeof TerminalTabBar> = {
  title: 'Workspace/TerminalTabBar',
  component: TerminalTabBar,
  args: {
    tabs: [
      { id: 'first', label: 'Terminal 1' },
      { id: 'second', label: 'Terminal 2' },
    ],
    activeTabId: 'first',
    onSelectTab: () => undefined,
    onCloseTab: () => undefined,
    onNewTab: () => undefined,
  },
  render: (args) => (
    <div className="w-[600px] rounded border bg-background text-foreground">
      <div className="border-b px-2 py-1">
        <TerminalTabBar {...args} />
      </div>
      <TerminalDisconnectBanner gaveUp onReconnect={() => undefined} />
      <pre className="p-3 text-sm">$ pnpm test</pre>
    </div>
  ),
} satisfies Meta<typeof TerminalTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { globals: { theme: 'light' } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const HighContrast: Story = { globals: { theme: 'dark', colorScheme: 'high-contrast' } };

// Exercise the production header while replacing PTY callbacks with local state.
function PanelHeader({ empty = false }: { empty?: boolean }) {
  const [active, setActive] = useState(false);
  const [tabs, setTabs] = useState(
    empty
      ? []
      : [
          { id: 'first', label: 'Terminal 1' },
          { id: 'second', label: 'Terminal 2' },
        ]
  );
  const [activeTabId, setActiveTabId] = useState('first');
  const openTerminal = () => {
    setActive(true);
    if (tabs.length === 0) {
      setTabs([{ id: 'first', label: 'Terminal 1' }]);
    }
  };
  return (
    <div className="flex w-[600px] items-center gap-0.5 bg-shell p-1">
      <TerminalControls
        activeBottomTab={active ? 'terminal' : 'setup-logs'}
        terminalTabState={{
          tabs,
          activeTabId,
          onSelectTab: setActiveTabId,
          onCloseTab: (id) => setTabs(tabs.filter((tab) => tab.id !== id)),
          onNewTab: () => undefined,
        }}
        onTabChange={openTerminal}
        leadingTabs={
          <TabButton
            label="Logs"
            icon={<StatusDot tone="success" size="xs" />}
            isActive={!active}
            onSelect={() => setActive(false)}
          />
        }
      />
    </div>
  );
}

export const PanelSelection: Story = {
  globals: { theme: 'light' },
  render: () => <PanelHeader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const terminal = canvas.getByRole('tab', { name: 'Terminal 2' });
    const before = terminal.getBoundingClientRect();
    const font = getComputedStyle(terminal).font;
    await userEvent.click(terminal);
    await expect(terminal).toHaveAttribute('aria-selected', 'true');
    await expect(terminal.getBoundingClientRect().height).toBe(before.height);
    await expect(terminal.getBoundingClientRect().width).toBe(before.width);
    await expect(getComputedStyle(terminal).font).toBe(font);
    await expect(getComputedStyle(terminal).fontSize).toBe('12px');
    await userEvent.click(canvas.getByRole('tab', { name: 'Logs' }));
    await expect(canvas.getByRole('tab', { name: 'Terminal 2' })).toBe(terminal);
    await expect(terminal).toHaveAttribute('aria-selected', 'false');
    await expect(terminal.getBoundingClientRect().height).toBe(before.height);
    await expect(terminal.getBoundingClientRect().width).toBe(before.width);
    await userEvent.click(terminal);
  },
};

export const PanelSelectionDark: Story = { ...PanelSelection, globals: { theme: 'dark' } };

/** Logs and the terminals are one tablist: one Tab stop, arrows move, Delete closes. */
export const KeyboardNavigation: Story = {
  globals: { theme: 'light' },
  render: () => <PanelHeader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tablist', { name: 'Terminals' })).toBeVisible();
    const logs = canvas.getByRole('tab', { name: 'Logs' });
    await userEvent.click(logs);
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('tab', { name: 'Terminal 1' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    const second = canvas.getByRole('tab', { name: 'Terminal 2' });
    await expect(second).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    // Delete, or Backspace on macOS.
    await userEvent.keyboard(`{${second.getAttribute('aria-keyshortcuts')}}`);
    await expect(canvas.queryByRole('tab', { name: 'Terminal 2' })).not.toBeInTheDocument();
    await waitFor(() => expect(canvas.getByRole('tab', { name: 'Terminal 1' })).toHaveFocus());
    await userEvent.keyboard('{Home}');
    await expect(logs).toHaveFocus();
  },
};

export const Phone: Story = {
  globals: { theme: 'light', viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <div className="w-full">
      <PanelHeader />
    </div>
  ),
};

export const EmptyPanel: Story = {
  render: () => <PanelHeader empty />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const terminal = canvas.getByRole('tab', { name: 'Terminal' });
    const height = terminal.getBoundingClientRect().height;
    const font = getComputedStyle(terminal).font;
    await userEvent.click(terminal);
    const first = canvas.getByRole('tab', { name: 'Terminal 1' });
    await expect(first.getBoundingClientRect().height).toBe(height);
    await expect(getComputedStyle(first).font).toBe(font);
  },
};
