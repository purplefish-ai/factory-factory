import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel } from '@/components/ui/resizable';

/** Keep in sync with the `[data-side-panel-motion]` transition in globals.css. */
export const SIDE_PANEL_MOTION_MS = 150;

type SidePanelMotion = 'opening' | 'closing' | null;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The workspace tools panel inside the horizontal split. It animates its share
 * of the split when toggled, and stays mounted until the close animation ends.
 * Must be a direct child of the `ResizablePanelGroup`.
 */
export function WorkspaceSidePanel({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [motion, setMotion] = useState<SidePanelMotion>(null);
  const [prevVisible, setPrevVisible] = useState(visible);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);

  if (visible !== prevVisible) {
    setPrevVisible(visible);
    const animate = !prefersReducedMotion();
    setMotion(animate ? (visible ? 'opening' : 'closing') : null);
    setMounted(visible || animate);
  }

  useEffect(() => {
    if (!motion) {
      setContentWidth(null);
      return;
    }
    // Pin the content to the panel's open width so it is clipped instead of
    // reflowing on every frame. The panel's layout size ignores the CSS
    // animation, so it is the open width while opening and while closing.
    const frame = requestAnimationFrame(() => {
      const group = panelElementRef.current?.parentElement;
      const panel = panelRef.current;
      if (group && panel) {
        setContentWidth(Math.round((group.offsetWidth * panel.getSize().asPercentage) / 100));
      }
    });
    const timer = setTimeout(() => {
      if (motion === 'closing') {
        setMounted(false);
      }
      setMotion(null);
    }, SIDE_PANEL_MOTION_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [motion]);

  if (!mounted) {
    return null;
  }

  return (
    <>
      <ResizableHandle />
      <ResizablePanel
        id="workspace-side"
        defaultSize="30%"
        minSize="15%"
        maxSize="50%"
        panelRef={panelRef}
        elementRef={panelElementRef}
        data-side-panel-motion={motion ?? undefined}
        style={contentWidth ? { minWidth: contentWidth } : undefined}
      >
        <div className="h-full border-l">{children}</div>
      </ResizablePanel>
    </>
  );
}
