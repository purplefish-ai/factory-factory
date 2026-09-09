import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, waitFor } from 'storybook/test';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button, buttonVariants } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

const meta = {
  title: 'UI/Dialog',
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ModalAnimationPreview() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);

  return (
    <div className="flex gap-3">
      <Button onClick={() => setDialogOpen(true)}>Open regular modal</Button>
      <Button variant="destructive" onClick={() => setAlertOpen(true)}>
        Open confirmation modal
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regular modal</DialogTitle>
            <DialogDescription>
              This content should fade and scale without traveling across the viewport.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmation modal</AlertDialogTitle>
            <AlertDialogDescription>
              Confirmation content should use the same centered motion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const CenteredMotion: Story = {
  render: () => <ModalAnimationPreview />,
};

export const FooterClose: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Workspace details</DialogTitle>
          <DialogDescription>Dismiss using the footer button or Escape.</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  ),
};

export const WideModal: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Attachment preview</DialogTitle>
          <DialogDescription>Wide content keeps its requested width.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const dialog = canvasElement.ownerDocument.querySelector('[role="dialog"]');
    if (!dialog) {
      throw new Error('Dialog did not render');
    }
    if (window.innerWidth >= 1024) {
      await waitFor(() => expect(dialog.getBoundingClientRect().width).toBe(896));
    } else {
      await expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(
        window.innerWidth - 32
      );
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await expect(getComputedStyle(dialog).animationName).toBe('none');
    }
  },
};

export const DestructiveConfirmation: Story = {
  render: () => (
    <AlertDialog defaultOpen>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
          <AlertDialogDescription>This action removes the workspace.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'destructive' })}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  play: async ({ canvasElement }) => {
    const dialog = canvasElement.ownerDocument.querySelector('[role="alertdialog"]');
    const action = dialog?.querySelector('[data-slot="alert-dialog-action"]');
    if (!(dialog && action)) {
      throw new Error('Confirmation did not render');
    }
    // Resolve the theme token in the same context as the action button.
    const colorSample = document.createElement('span');
    colorSample.style.backgroundColor = 'var(--destructive)';
    dialog.append(colorSample);
    try {
      if (!document.documentElement.classList.contains('dark')) {
        await expect(getComputedStyle(action).backgroundColor).toBe(
          getComputedStyle(colorSample).backgroundColor
        );
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await expect(getComputedStyle(dialog).animationName).toBe('none');
      }
    } finally {
      colorSample.remove();
    }
  },
};
