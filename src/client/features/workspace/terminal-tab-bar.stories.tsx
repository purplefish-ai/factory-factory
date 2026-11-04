import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { TabButton } from '@/components/ui/tab-button';
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

// Match the right panel's placeholder-to-terminal transition without a live PTY.
function PanelHeader() {
  const [active, setActive] = useState(false);
  return (
    <div className="flex w-[600px] items-center gap-0.5 bg-shell p-1">
      <TabButton label="Logs" icon={null} isActive={!active} onSelect={() => setActive(false)} />
      {active ? (
        <TerminalTabBar
          tabs={[{ id: 'first', label: 'Terminal 1' }]}
          activeTabId="first"
          onSelectTab={() => setActive(true)}
          onCloseTab={() => setActive(false)}
          onNewTab={() => undefined}
        />
      ) : (
        <TabButton
          label="Terminal"
          icon={<TerminalIcon className="h-3.5 w-3.5" />}
          isActive={false}
          onSelect={() => setActive(true)}
        />
      )}
    </div>
  );
}

export const PanelSelection: Story = {
  globals: { theme: 'light' },
  render: () => <PanelHeader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const logs = canvas.getByRole('button', { name: 'Logs' });
    const placeholder = canvas.getByRole('button', { name: 'Terminal' });
    const height = placeholder.getBoundingClientRect().height;
    const font = getComputedStyle(placeholder).font;
    const selectedLogs = getComputedStyle(logs);
    const selectedForeground = selectedLogs.color;
    await userEvent.click(placeholder);
    const terminal = canvas.getByRole('button', { name: 'Terminal 1' });
    const tab = terminal.parentElement!;
    await expect(tab.getBoundingClientRect().height).toBe(height);
    await expect(getComputedStyle(terminal).font).toBe(font);
    await expect(getComputedStyle(terminal).color).toBe(selectedForeground);
    await userEvent.click(logs);
    await expect(
      canvas.getByRole('button', { name: 'Terminal' }).getBoundingClientRect().height
    ).toBe(height);
  },
};

export const PanelSelectionDark: Story = {
  ...PanelSelection,
  globals: { theme: 'dark' },
};
