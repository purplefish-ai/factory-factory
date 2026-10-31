import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export function WorkspaceToolsDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!(open && window.visualViewport)) {
      return;
    }
    const visibleViewport = window.visualViewport;
    const update = () =>
      setViewport({ height: visibleViewport.height, top: visibleViewport.offsetTop });
    update();
    visibleViewport.addEventListener('resize', update);
    visibleViewport.addEventListener('scroll', update);
    return () => {
      visibleViewport.removeEventListener('resize', update);
      visibleViewport.removeEventListener('scroll', update);
    };
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[calc(100%-1.5rem)] max-w-[44rem] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] data-[state=open]:duration-200 data-[state=closed]:duration-200 sm:max-w-[44rem] [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center"
        style={
          viewport
            ? { top: viewport.top, height: viewport.height, bottom: 'auto' }
            : { height: '100dvh' }
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          // Returning to an editable control would reopen the software keyboard.
          if (target?.isConnected && !target.matches('input, textarea, [contenteditable="true"]')) {
            target.focus({ preventScroll: true });
          }
        }}
      >
        <SheetHeader className="shrink-0 border-b px-4 pb-3 pr-14 pt-[max(1rem,env(safe-area-inset-top))] text-left">
          <SheetTitle ref={titleRef} tabIndex={-1} className="text-sm outline-none">
            Workspace tools
          </SheetTitle>
          <SheetDescription className="sr-only">
            Review changes or use the terminal, then return to your session.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
