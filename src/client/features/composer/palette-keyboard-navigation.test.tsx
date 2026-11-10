// @vitest-environment jsdom
import { createElement, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PaletteKeyboardHandle,
  usePaletteKeyboardNavigation,
} from './palette-keyboard-navigation';

const committed: number[] = [];

function Palette({
  isOpen,
  resetKey,
  onSelectByIndex,
  paletteRef,
}: {
  isOpen: boolean;
  resetKey: string;
  onSelectByIndex: (index: number) => boolean;
  paletteRef: React.RefObject<PaletteKeyboardHandle | null>;
}) {
  const anchorRef = useRef<HTMLElement>(null);
  const { selectedIndex } = usePaletteKeyboardNavigation({
    isOpen,
    itemCount: 3,
    resetKey,
    onClose: vi.fn(),
    onSelectByIndex,
    anchorRef,
    paletteRef,
  });
  // Layout effects see each commit before passive effects could correct it.
  useLayoutEffect(() => {
    committed.push(selectedIndex);
  });
  return null;
}

afterEach(() => {
  committed.length = 0;
});

describe('usePaletteKeyboardNavigation', () => {
  it('selects the first item in the first commit after the filter changes or it reopens', () => {
    const root = createRoot(document.createElement('div'));
    const paletteRef: React.RefObject<PaletteKeyboardHandle | null> = { current: null };
    const onSelectByIndex = vi.fn(() => true);
    const render = (isOpen: boolean, resetKey: string) =>
      flushSync(() =>
        root.render(createElement(Palette, { isOpen, resetKey, onSelectByIndex, paletteRef }))
      );

    render(true, '');
    flushSync(() => paletteRef.current?.handleKeyDown('ArrowDown'));
    flushSync(() => paletteRef.current?.handleKeyDown('ArrowDown'));
    expect(committed.at(-1)).toBe(2);
    expect(paletteRef.current?.handleKeyDown('Enter')).toBe('handled');
    expect(onSelectByIndex).toHaveBeenLastCalledWith(2);

    committed.length = 0;
    render(true, 'a');
    expect(committed).toEqual([0]);

    flushSync(() => paletteRef.current?.handleKeyDown('ArrowDown'));
    render(false, 'a');
    committed.length = 0;
    render(true, 'a');
    expect(committed).toEqual([0]);
    expect(paletteRef.current?.handleKeyDown('Tab')).toBe('handled');
    expect(onSelectByIndex).toHaveBeenLastCalledWith(0);
    flushSync(() => root.unmount());
  });
});
