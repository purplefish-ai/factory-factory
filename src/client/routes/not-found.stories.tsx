import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, within } from 'storybook/test';
import NotFoundPage from './not-found';

const meta = {
  title: 'Navigation/NotFoundPage',
  component: NotFoundPage,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="h-[480px]">
      <Routes>
        <Route path="/" element={<Navigate to="/projects/example/unknown-page" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  ),
} satisfies Meta<typeof NotFoundPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An unmatched URL renders inside the app shell with a way back home. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Page not found')).toBeVisible();
    await expect(canvas.getByText('/projects/example/unknown-page')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: Default.play,
};
