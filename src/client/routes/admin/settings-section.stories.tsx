import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { QueryStateQuery } from '@/client/components/query-state';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  SETTING_FIELD_WIDTH,
  SettingRow,
  SettingSelect,
  SettingsSection,
} from './settings-section';

interface ExampleSettings {
  sound: boolean;
  voice: 'aria' | 'jack';
}

const refetch = fn();

/** One section with a row and a field, driven by a fixed query snapshot. */
function ExampleSection({
  data,
  error,
  saving = false,
}: {
  data?: ExampleSettings;
  error?: string;
  saving?: boolean;
}) {
  const query: QueryStateQuery<ExampleSettings> = {
    data,
    error: error ? { message: error } : null,
    isFetching: false,
    refetch,
  };
  const [sound, setSound] = useState(data?.sound ?? false);
  return (
    <div className="max-w-2xl">
      <SettingsSection
        title="Notifications"
        icon={<BellIcon className="size-5" />}
        description="Choose how to hear about workspace completions."
        action={
          <Button variant="link" size="inline">
            Reset
          </Button>
        }
        query={query}
        errorTitle="Couldn't load notification settings"
      >
        {(settings) => (
          <>
            <SettingRow
              label="Play completion sound"
              htmlFor="example-sound"
              description="Play a sound when a workspace finishes."
              saving={saving}
            >
              <Switch id="example-sound" checked={sound} onCheckedChange={setSound} />
            </SettingRow>
            <SettingSelect
              id="example-voice"
              label="Voice"
              description="Used when reading replies aloud."
              value={settings.voice}
              options={[
                { value: 'aria', label: 'Aria' },
                { value: 'jack', label: 'Jack' },
              ]}
              onValueChange={fn()}
              triggerClassName={SETTING_FIELD_WIDTH}
            />
          </>
        )}
      </SettingsSection>
    </div>
  );
}

const meta = {
  title: 'Settings/SettingsSection',
  component: ExampleSection,
  parameters: { layout: 'padded' },
  beforeEach: () => {
    refetch.mockClear();
  },
} satisfies Meta<typeof ExampleSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loaded: Story = {
  args: { data: { sound: true, voice: 'aria' } },
};

export const Loading: Story = {
  args: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Notifications')).toBeVisible();
    await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
  },
};

export const LoadError: Story = {
  args: { error: 'Database is locked' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      "Couldn't load notification settings"
    );
    await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(refetch).toHaveBeenCalledOnce();
  },
};

/** A failed background refresh keeps the cached controls under a notice. */
export const RefreshError: Story = {
  args: { data: { sound: true, voice: 'aria' }, error: 'Database is locked' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('switch')).toBeVisible();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    const notice = canvas.getByRole('status');
    await expect(notice).toHaveTextContent("Couldn't refresh.");
    await expect(notice).toHaveTextContent('Database is locked');
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await expect(refetch).toHaveBeenCalledOnce();
  },
};

export const RefreshErrorPhone: Story = {
  ...RefreshError,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: undefined,
};

export const RefreshErrorDark: Story = {
  ...RefreshError,
  globals: { theme: 'dark' },
  play: undefined,
};

export const Saving: Story = {
  args: { data: { sound: true, voice: 'aria' }, saving: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Saving' })).toBeVisible();
    await expect(canvas.getByRole('switch', { name: 'Play completion sound' })).toBeEnabled();
  },
};

export const SavingPhone: Story = {
  ...Saving,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const SavingDark: Story = { ...Saving, globals: { theme: 'dark' } };
