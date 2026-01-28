'use client';

import { GripVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

type ResizablePanelGroupProps = Omit<ComponentProps<typeof Group>, 'orientation'> & {
  /** Alias for orientation to maintain shadcn API compatibility */
  direction?: 'horizontal' | 'vertical';
};

const ResizablePanelGroup = ({
  className,
  direction = 'horizontal',
  ...props
}: ResizablePanelGroupProps) => (
  <Group
    orientation={direction}
    className={cn('flex h-full w-full', direction === 'vertical' && 'flex-col', className)}
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) => (
  <Separator
    className={cn(
      'relative flex items-center justify-center bg-border transition-colors hover:bg-primary/50',
      'w-px after:absolute after:inset-y-0 after:left-1/2 after:w-4 after:-translate-x-1/2',
      'data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full',
      'data-[orientation=vertical]:after:inset-x-0 data-[orientation=vertical]:after:inset-y-auto',
      'data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:h-4 data-[orientation=vertical]:after:w-full',
      'data-[orientation=vertical]:after:-translate-y-1/2 data-[orientation=vertical]:after:translate-x-0',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
      '[&[data-orientation=vertical]>div]:rotate-90',
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
