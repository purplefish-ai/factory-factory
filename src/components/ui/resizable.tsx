import { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical';
import type { ComponentProps } from 'react';
import { useCallback, useMemo } from 'react';
import type { Layout, LayoutChangedMeta } from 'react-resizable-panels';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { z } from 'zod';
import { readStoredJson, writeStoredJson } from '@/client/lib/browser-storage';
import { cn } from '@/lib/utils';

type ResizablePanelGroupProps = Omit<ComponentProps<typeof Group>, 'orientation'> & {
  /** Alias for orientation to maintain shadcn API compatibility */
  direction?: 'horizontal' | 'vertical';
  /** Unique ID for persisting layout to localStorage */
  autoSaveId?: string;
};

function isLayout(value: unknown): value is Layout {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

const LayoutSchema = z.custom<Layout>(isLayout);

function layoutStorageKey(autoSaveId: string): string {
  return `resizable-panels:${autoSaveId}`;
}

function loadLayoutFromStorage(autoSaveId: string): Layout | undefined {
  return readStoredJson(layoutStorageKey(autoSaveId), LayoutSchema);
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

  // Save layout when it changes
  const handleLayoutChange = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      // Call the consumer's callback first
      onLayoutChangedProp?.(layout, meta);

      if (!autoSaveId) {
        return;
      }

      // A conditional panel removal must not replace a complete split with a
      // smaller layout. Read the latest save, not the render-time default: the
      // user may have resized since mount. Keep full commits (including the
      // library's imperative double-click resets) persistent as before.
      const savedLayout = loadLayoutFromStorage(autoSaveId);
      if (
        !meta.isUserInteraction &&
        savedLayout &&
        Object.keys(layout).length < Object.keys(savedLayout).length
      ) {
        return;
      }

      writeStoredJson(layoutStorageKey(autoSaveId), meta.requestedLayout ?? layout);
    },
    [autoSaveId, onLayoutChangedProp]
  );

  return (
    <Group
      data-slot="resizable-panel-group"
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
      data-slot="resizable-handle"
      className={cn(
        // Base styles
        'relative flex items-center justify-center bg-border transition-colors hover:bg-primary/50',
        // Focus styles
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        // Orientation-specific styles
        isHorizontalHandle
          ? // Horizontal handle (for vertical panel groups)
            "h-1 w-full cursor-row-resize after:content-[''] after:absolute after:inset-x-0 after:top-1/2 after:h-4 after:-translate-y-1/2"
          : // Vertical handle (for horizontal panel groups) - default
            "w-px cursor-col-resize after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-4 after:-translate-x-1/2",
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
          <DotsSixVerticalIcon className="h-2.5 w-2.5" />
        </div>
      )}
    </Separator>
  );
};

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
