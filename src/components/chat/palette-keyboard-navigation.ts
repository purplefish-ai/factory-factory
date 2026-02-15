import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

/**
 * Result of handling a keyboard event in an autocomplete palette.
 * - 'handled': Event was fully handled, caller should preventDefault
 * - 'passthrough': Event should be handled by normal input logic
 * - 'close-and-passthrough': Menu should close but event should still be processed
 */
export type PaletteKeyResult = 'handled' | 'passthrough' | 'close-and-passthrough';

/**
 * Imperative keyboard handle for palettes.
 */
export interface PaletteKeyboardHandle {
  handleKeyDown: (key: string) => PaletteKeyResult;
}

interface UsePaletteKeyboardNavigationOptions {
  isOpen: boolean;
  itemCount: number;
  resetKey: string;
  onClose: () => void;
  onSelectByIndex: (index: number) => boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  paletteRef?: React.RefObject<PaletteKeyboardHandle | null>;
}

interface UsePaletteKeyboardNavigationReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  itemRefs: React.RefObject<Array<HTMLDivElement | null>>;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}

export function usePaletteKeyboardNavigation({
  isOpen,
  itemCount,
  resetKey,
  onClose,
  onSelectByIndex,
  anchorRef,
  paletteRef,
}: UsePaletteKeyboardNavigationOptions): UsePaletteKeyboardNavigationReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(selectedIndex);
  const prevResetKeyRef = useRef(resetKey);

  // Reset selection when input filter changes while open.
  useEffect(() => {
    const filterChanged = prevResetKeyRef.current !== resetKey;
    prevResetKeyRef.current = resetKey;

    if (isOpen && filterChanged) {
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
    }
  }, [isOpen, resetKey]);

  // Keep selectedIndex ref in sync with state.
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Keep refs array in sync with current item count.
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, itemCount);
  }, [itemCount]);

  // Ensure the selected item stays visible when navigating with the keyboard.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, selectedIndex]);

  // Click outside to close.
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  const handleArrowDown = useCallback(() => {
    if (itemCount > 0) {
      setSelectedIndex((prev) => Math.min(prev + 1, itemCount - 1));
    }
    return 'handled' as const;
  }, [itemCount]);

  const handleArrowUp = useCallback(() => {
    if (itemCount > 0) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }
    return 'handled' as const;
  }, [itemCount]);

  const selectCurrentItem = useCallback(() => {
    if (itemCount <= 0) {
      return false;
    }
    const currentIndex = selectedIndexRef.current;
    if (currentIndex < 0 || currentIndex >= itemCount) {
      return false;
    }
    return onSelectByIndex(currentIndex);
  }, [itemCount, onSelectByIndex]);

  const handleEnter = useCallback((): PaletteKeyResult => {
    if (selectCurrentItem()) {
      return 'handled';
    }
    return 'close-and-passthrough';
  }, [selectCurrentItem]);

  const handleTab = useCallback((): PaletteKeyResult => {
    if (selectCurrentItem()) {
      return 'handled';
    }
    return 'passthrough';
  }, [selectCurrentItem]);

  const handleEscape = useCallback(() => {
    onClose();
    return 'handled' as const;
  }, [onClose]);

  const keyHandlers = useMemo(
    () => ({
      ArrowDown: handleArrowDown,
      ArrowUp: handleArrowUp,
      Enter: handleEnter,
      Tab: handleTab,
      Escape: handleEscape,
    }),
    [handleArrowDown, handleArrowUp, handleEnter, handleTab, handleEscape]
  );

  const handleKeyDown = useCallback(
    (key: string): PaletteKeyResult => {
      const handler = keyHandlers[key as keyof typeof keyHandlers];
      return handler ? handler() : 'passthrough';
    },
    [keyHandlers]
  );

  useImperativeHandle(
    paletteRef,
    () => ({
      handleKeyDown,
    }),
    [handleKeyDown]
  );

  return {
    containerRef,
    itemRefs,
    selectedIndex,
    setSelectedIndex,
  };
}
