import type { Meta, StoryObj } from '@storybook/react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { SettingsTabsList } from './settings-tabs-list';

const meta = {
  title: 'Settings/TabsList',
  component: SettingsTabsList,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="p-3 md:p-6">
      <Tabs defaultValue="general">
        <SettingsTabsList />
        <TabsContent value="general">General settings</TabsContent>
        <TabsContent value="appearance">Appearance settings</TabsContent>
        <TabsContent value="project">Project settings</TabsContent>
        <TabsContent value="voice">Voice mode settings</TabsContent>
      </Tabs>
    </div>
  ),
} satisfies Meta<typeof SettingsTabsList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const NarrowMobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  decorators: [
    (Story) => (
      <div className="w-[320px] max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: { description: { story: 'Scroll the menu horizontally to reach every settings tab.' } },
  },
};
