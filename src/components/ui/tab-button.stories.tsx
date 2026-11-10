import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SessionStatusIcon } from '@/client/components/session-status-icon';
import { StatusDot } from '@/client/components/status-indicators';
import { deriveSessionTabRuntime } from '@/client/lib/session-tab-runtime';
import { TabButton, TabList } from './tab-button';

const meta = {
  title: 'UI/TabButton',
  component: TabButton,
} satisfies Meta<typeof TabButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every variant a tab bar uses: icon, status slot, close, truncation, sm, icon-only, disabled. */
function Gallery() {
  // Each tablist keeps its own selection, so each always has one Tab stop.
  const [active, setActive] = useState('chat');
  const [activeSmall, setActiveSmall] = useState('setup');
  const [files, setFiles] = useState(['button.tsx', 'a-very-long-file-name-that-truncates.tsx']);
  const tab = (id: string) => ({ isActive: active === id, onSelect: () => setActive(id) });
  const smallTab = (id: string) => ({
    isActive: activeSmall === id,
    onSelect: () => setActiveSmall(id),
  });
  const closeFile = (file: string) => {
    const remaining = files.filter((name) => name !== file);
    setFiles(remaining);
    if (active === file) {
      setActive(remaining[0] ?? 'chat');
    }
  };
  return (
    <div className="flex flex-col gap-3 bg-shell p-2">
      <TabList aria-label="Default size" className="flex-wrap gap-0.5">
        <TabButton
          label="Chat 1"
          icon={<SessionStatusIcon status={deriveSessionTabRuntime(undefined, 'RUNNING')} />}
          {...tab('chat')}
        />
        <TabButton
          label="Agent"
          icon={
            <SessionStatusIcon status={deriveSessionTabRuntime(undefined, 'COMPLETED')} isAgent />
          }
          {...tab('agent')}
        />
        {files.map((file) => (
          <TabButton
            key={file}
            label={file}
            icon={<FileCodeIcon className="h-3.5 w-3.5 shrink-0" />}
            onClose={() => closeFile(file)}
            truncate
            {...tab(file)}
          />
        ))}
        <TabButton label="Disabled" disabled {...tab('disabled')} />
        <TabButton
          label="Screenshots"
          hideLabel
          icon={<CameraIcon className="h-3.5 w-3.5" />}
          {...tab('screenshots')}
        />
      </TabList>
      <TabList aria-label="Small size" className="flex-wrap gap-0.5">
        <TabButton
          size="sm"
          label="Setup"
          icon={<StatusDot tone="success" size="xs" />}
          {...smallTab('setup')}
        />
        <TabButton
          size="sm"
          label="Dev"
          icon={<StatusDot tone="working" size="xs" />}
          {...smallTab('dev')}
        />
        <TabButton
          size="sm"
          label="Terminal 1"
          icon={<TerminalIcon className="h-3 w-3 shrink-0" />}
          onClose={() => undefined}
          {...smallTab('terminal')}
        />
      </TabList>
    </div>
  );
}

export const Light: Story = {
  args: { label: 'Tab', isActive: false, onSelect: () => undefined },
  globals: { theme: 'light' },
  render: () => <Gallery />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chat = canvas.getByRole('tab', { name: 'Running Chat 1' });
    await expect(chat).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('tab', { name: 'Screenshots' })).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'Disabled' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await userEvent.click(canvas.getByRole('tab', { name: 'Dev' }));
    await expect(canvas.getByRole('tab', { name: 'Dev' })).toHaveAttribute('aria-selected', 'true');
    await expect(chat).toHaveAttribute('aria-selected', 'true');
    // Closing the selected file selects a remaining one, so the list keeps a Tab stop.
    await userEvent.click(canvas.getByRole('tab', { name: 'button.tsx' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Close button.tsx' }));
    await expect(
      canvas.getByRole('tab', { name: 'a-very-long-file-name-that-truncates.tsx' })
    ).toHaveAttribute('aria-selected', 'true');
    for (const list of canvas.getAllByRole('tablist')) {
      const stops = within(list)
        .getAllByRole('tab')
        .filter((tab) => tab.tabIndex === 0);
      await expect(stops).toHaveLength(1);
    }
  },
};

export const Dark: Story = { ...Light, globals: { theme: 'dark' } };

export const Phone: Story = {
  ...Light,
  globals: { theme: 'light', viewport: { value: 'phone', isRotated: false } },
};

/** Enter and Space select the focused tab exactly once each (no extra native click). */
export const KeyboardSelection: Story = {
  args: { label: 'Alpha', isActive: false, onSelect: fn(), onClose: fn() },
  render: (args) => (
    <TabList aria-label="Keyboard selection">
      <TabButton {...args} tabStop />
    </TabList>
  ),
  play: async ({ args, canvasElement }) => {
    const tab = within(canvasElement).getByRole('tab', { name: 'Alpha' });
    tab.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSelect).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    await expect(args.onSelect).toHaveBeenCalledTimes(2);
    await userEvent.click(tab);
    await expect(args.onSelect).toHaveBeenCalledTimes(3);
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};
