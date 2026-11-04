import type { Meta, StoryObj } from '@storybook/react';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';
import { TerminalTabBar } from './terminal-tab-bar';

const meta: Meta<typeof TerminalTabBar> = {
  title: 'Workspace/TerminalTabs',
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
