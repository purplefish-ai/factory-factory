import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
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
  const [active, setActive] = useState('chat');
  const [files, setFiles] = useState(['button.tsx', 'a-very-long-file-name-that-truncates.tsx']);
  const tab = (id: string) => ({ isActive: active === id, onSelect: () => setActive(id) });
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
            onClose={() => setFiles(files.filter((name) => name !== file))}
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
          {...tab('setup')}
        />
        <TabButton
          size="sm"
          label="Dev"
          icon={<StatusDot tone="working" size="xs" />}
          {...tab('dev')}
        />
        <TabButton
          size="sm"
          label="Terminal 1"
          icon={<TerminalIcon className="h-3 w-3 shrink-0" />}
          onClose={() => undefined}
          {...tab('terminal')}
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
    await expect(chat).toHaveAttribute('aria-selected', 'false');
  },
};

export const Dark: Story = { ...Light, globals: { theme: 'dark' } };

export const Phone: Story = {
  ...Light,
  globals: { theme: 'light', viewport: { value: 'phone', isRotated: false } },
};
