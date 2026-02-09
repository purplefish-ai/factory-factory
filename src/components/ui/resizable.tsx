import { GripVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback, useMemo } from 'react';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

type ResizablePanelGroupProps = Omit<ComponentProps<typeof Group>, 'orientation'> & {
  /** Alias for orientation to maintain shadcn API compatibility */
  direction?: 'horizontal' | 'vertical';
  /** Unique ID for persisting layout to localStorage */
  autoSaveId?: string;
};

// Helper to load layout from localStorage synchronously
function loadLayoutFromStorage(autoSaveId: string): Layout | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const stored = localStorage.getItem(`resizable-panels:${autoSaveId}`);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      // Layout is a simple object type from react-resizable-panels
      return parsed as Layout;
    }
  } catch {
    // Ignore storage errors
  }
  return undefined;
}

const ResizablePanelGroup = ({
  className,
  direction = 'horizontal',
  autoSaveId,
  defaultLayout: defaultLayoutProp,
  onLayoutChanged: onLayoutChangedProp,
  ...props
}: ResizablePanelGroupProps) => {
  // Load layout synchronously during render to avoid flicker
  const storedLayout = useMemo(
    () => (autoSaveId ? loadLayoutFromStorage(autoSaveId) : undefined),
    [autoSaveId]
  );

  // Save layout to localStorage when it changes
  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      // Call the consumer's callback first
      onLayoutChangedProp?.(layout);

      if (!autoSaveId) {
        return;
      }

      try {
        localStorage.setItem(`resizable-panels:${autoSaveId}`, JSON.stringify(layout));
      } catch {
        // Ignore storage errors
      }
    },
    [autoSaveId, onLayoutChangedProp]
  );

  return (
    <Group
      orientation={direction}
      className={cn('flex h-full w-full', direction === 'vertical' && 'flex-col', className)}
      id={autoSaveId}
      defaultLayout={autoSaveId ? (storedLayout ?? defaultLayoutProp) : defaultLayoutProp}
      onLayoutChanged={handleLayoutChange}
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
