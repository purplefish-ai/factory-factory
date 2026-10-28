import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { ModelCatalogWarningContent } from './model-catalog-warning';

const meta = {
  title: 'Components/ModelCatalogWarning',
  component: ModelCatalogWarningContent,
  parameters: { layout: 'fullscreen' },
  args: { models: [{ provider: 'CLAUDE', model: 'claude-fable-5[1m]' }] },
} satisfies Meta<typeof ModelCatalogWarningContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MissingClaudeModel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('claude-fable-5[1m]');
    await expect(canvas.getByRole('link', { name: 'Review chat defaults' })).toHaveAttribute(
      'href',
      '/admin'
    );
  },
};
export const MissingCodexModel: Story = {
  args: { models: [{ provider: 'CODEX', model: 'retired-codex-model' }] },
};
export const BothProviders: Story = {
  args: {
    models: [
      { provider: 'CLAUDE', model: 'claude-fable-5[1m]' },
      { provider: 'CODEX', model: 'retired-codex-model' },
    ],
  },
};
export const Dark: Story = { globals: { theme: 'dark' } };
export const Narrow: Story = {
  args: { models: [{ provider: 'CLAUDE', model: `claude-${'long-model-name-'.repeat(6)}` }] },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};
export const Healthy: Story = { args: { models: [] } };
