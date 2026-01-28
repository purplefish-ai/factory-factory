'use client';

import { GripVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

type ResizablePanelGroupProps = Omit<ComponentProps<typeof Group>, 'orientation'> & {
  /** Alias for orientation to maintain shadcn API compatibility */
  direction?: 'horizontal' | 'vertical';
  /** Unique ID for persisting layout to localStorage */
  autoSaveId?: string;
};

// Custom hook for localStorage persistence that's safe during SSR
function useLayoutPersistence(autoSaveId: string | undefined) {
  const [defaultLayout, setDefaultLayout] = useState<Layout | undefined>(undefined);

  // Load layout from localStorage on mount
  useEffect(() => {
    if (!autoSaveId) {
      return;
    }
    try {
      const stored = localStorage.getItem(`resizable-panels:${autoSaveId}`);
      if (stored) {
        setDefaultLayout(JSON.parse(stored));
      }
    } catch {
      // Ignore storage errors
    }
  }, [autoSaveId]);

  // Save layout to localStorage when it changes
  const onLayoutChanged = useCallback(
    (layout: Layout) => {
      if (!autoSaveId) {
        return;
      }
      try {
        localStorage.setItem(`resizable-panels:${autoSaveId}`, JSON.stringify(layout));
      } catch {
        // Ignore storage errors
      }
    },
    [autoSaveId]
  );

  return { defaultLayout, onLayoutChanged };
}

const ResizablePanelGroup = ({
  className,
  direction = 'horizontal',
  autoSaveId,
  defaultLayout: defaultLayoutProp,
  onLayoutChanged: onLayoutChangedProp,
  ...props
}: ResizablePanelGroupProps) => {
  const persistence = useLayoutPersistence(autoSaveId);

  return (
    <Group
      orientation={direction}
      className={cn('flex h-full w-full', direction === 'vertical' && 'flex-col', className)}
      defaultLayout={autoSaveId ? persistence.defaultLayout : defaultLayoutProp}
      onLayoutChanged={autoSaveId ? persistence.onLayoutChanged : onLayoutChangedProp}
      {...props}
    />
  );
};

const ResizablePanel = Panel;

type ResizableHandleProps = ComponentProps<typeof Separator> & {
  withHandle?: boolean;
  /** Direction of the parent panel group - determines handle orientation */
  direction?: 'horizontal' | 'vertical';
};

const ResizableHandle = ({ withHandle, className, direction, ...props }: ResizableHandleProps) => {
  // For horizontal panel groups, the handle is a vertical line
  // For vertical panel groups, the handle is a horizontal line
  const isHorizontalHandle = direction === 'vertical';

  return (
    <Separator
      className={cn(
        // Base styles
        'relative flex items-center justify-center bg-border transition-colors hover:bg-primary/50',
        // Focus styles
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        // Orientation-specific styles
        isHorizontalHandle
          ? // Horizontal handle (for vertical panel groups)
            'h-1 w-full after:absolute after:inset-x-0 after:top-1/2 after:h-4 after:-translate-y-1/2'
          : // Vertical handle (for horizontal panel groups) - default
            'w-px after:absolute after:inset-y-0 after:left-1/2 after:w-4 after:-translate-x-1/2',
        className
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            'z-10 flex items-center justify-center rounded-sm border bg-border',
            isHorizontalHandle ? 'h-3 w-4 rotate-90' : 'h-4 w-3'
          )}
        >
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </Separator>
  );
};

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
