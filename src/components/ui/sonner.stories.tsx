import type { Meta, StoryObj } from '@storybook/react';
import { MutationObserver } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { expect, waitFor, within } from 'storybook/test';
import { createAppQueryClient } from '@/client/lib/query-client';
import { Button } from './button';
import { Toaster } from './sonner';

type ToastPreset = 'error-and-success' | 'mutation-fallback';

function showPreset(preset: ToastPreset) {
  if (preset === 'mutation-fallback') {
    const observer = new MutationObserver(createAppQueryClient(), {
      mutationFn: () => Promise.reject(new Error('spawn pnpm ENOENT')),
      meta: { errorToast: "Couldn't start dev server" },
    });
    observer.mutate().catch(() => undefined);
    return;
  }
  toast.success('Settings saved');
  toast.error("Couldn't delete screenshot", {
    description: 'EACCES: permission denied, unlink .factory-factory/screenshots/home.png',
  });
}

function ToasterStory({ preset }: { preset: ToastPreset }) {
  useEffect(() => {
    showPreset(preset);
    return () => {
      toast.dismiss();
    };
  }, [preset]);
  return (
    <div className="flex h-[360px] w-[640px] items-start justify-center p-6">
      <Button variant="outline" onClick={() => showPreset(preset)}>
        Show again
      </Button>
      <Toaster expand position="bottom-right" />
    </div>
  );
}

const meta = {
  title: 'UI/Toaster',
  component: ToasterStory,
  // This story renders the Toaster under test; skip the preview's global one.
  parameters: { toaster: false },
  args: { preset: 'error-and-success' },
} satisfies Meta<typeof ToasterStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Error toasts use a title for what failed and a description for the server
 * detail. They stay for 10 s and have a close button; success toasts keep
 * sonner's 4 s default without one.
 */
export const ErrorAndSuccess: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const error = await body.findByText("Couldn't delete screenshot");
    const errorToast = error.closest('[data-sonner-toast]');
    await waitFor(() => expect(errorToast?.querySelector('[data-close-button]')).not.toBeNull());
    const success = (await body.findByText('Settings saved')).closest('[data-sonner-toast]');
    await expect(success?.querySelector('[data-close-button]')).toBeNull();
  },
};

/** A mutation without its own error handling falls back to the app's toast. */
export const MutationFallback: Story = {
  args: { preset: 'mutation-fallback' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const title = await body.findByText("Couldn't start dev server");
    await waitFor(() => expect(title).toBeVisible());
    await expect(await body.findByText('spawn pnpm ENOENT')).toBeInTheDocument();
  },
};
