import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { usePersistedState } from '@/client/hooks/use-persisted-state';
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  StoredSidebarWidthSchema,
} from './app-sidebar-resize';

/**
 * The desktop sidebar's width and its resize handle. The width follows the
 * pointer during a drag and is stored once the drag ends. Closing the sidebar
 * or unmounting ends a drag in progress.
 */
export function useSidebarResize(open: boolean) {
  const [storedWidth, setStoredWidth] = usePersistedState(
    SIDEBAR_WIDTH_STORAGE_KEY,
    StoredSidebarWidthSchema,
    SIDEBAR_DEFAULT_WIDTH,
    { format: 'text' }
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const endDragRef = useRef<(() => void) | null>(null);
  const width = dragWidth ?? storedWidth;

  useEffect(() => {
    if (!open) {
      endDragRef.current?.();
    }
  }, [open]);

  useEffect(() => () => endDragRef.current?.(), []);

  const onResizePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !open) {
      return;
    }

    event.preventDefault();
    endDragRef.current?.();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    let draggedWidth: number | null = null;
    const handleElement = event.currentTarget;
    const controller = new AbortController();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const endDrag = () => {
      controller.abort();
      if (draggedWidth !== null) {
        setStoredWidth(draggedWidth);
      }
      setDragWidth(null);
      setIsResizing(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      endDragRef.current = null;
      if (handleElement.hasPointerCapture(pointerId)) {
        handleElement.releasePointerCapture(pointerId);
      }
    };

    endDragRef.current = endDrag;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handleElement.setPointerCapture(pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      draggedWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setDragWidth(draggedWidth);
    };
    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) {
        endDrag();
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { signal: controller.signal });
    window.addEventListener('pointerup', handlePointerEnd, { signal: controller.signal });
    window.addEventListener('pointercancel', handlePointerEnd, { signal: controller.signal });
  };

  return { width, isResizing, onResizePointerDown };
}
