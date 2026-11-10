import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ColumnConfig } from './kanban-column';

interface MobileBoardSection {
  column: ColumnConfig;
  count: number;
  visible: boolean;
  content: ReactNode;
}

function isAtScrollEnd(scroll: HTMLElement): boolean {
  return scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
}

export function MobileBoardSections({
  sections,
  showInlineForm,
  inlineFormRequest,
  workspaceCreationRequest,
}: {
  sections: MobileBoardSection[];
  showInlineForm: boolean;
  inlineFormRequest: number;
  workspaceCreationRequest: number;
}) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const navigationTarget = useRef<{ columnId: string; scrollTop: number } | null>(null);
  const lastCreationRequest = useRef(workspaceCreationRequest);
  const lastRevealedFormRequest = useRef<number | null>(null);
  const [activeId, setActiveId] = useState('ISSUES');
  const visibleSections = sections.filter((section) => section.visible);
  const updateActiveSection = useStableCallback((currentSections: MobileBoardSection[]) => {
    const visibleSections = currentSections.filter((section) => section.visible);
    const scroll = scrollRef.current;
    const navigation = navigationRef.current;
    const first = visibleSections[0];
    if (!(scroll && navigation && first)) {
      return;
    }
    // Retain an explicit jump while it stays at its destination, including when
    // several short sections share the same clamped position at the bottom.
    const target = navigationTarget.current;
    if (
      target &&
      Math.abs(scroll.scrollTop - target.scrollTop) < 1 &&
      visibleSections.some(({ column }) => column.id === target.columnId)
    ) {
      setActiveId(target.columnId);
      return;
    }
    navigationTarget.current = null;
    if (isAtScrollEnd(scroll)) {
      setActiveId((visibleSections.at(-1) ?? first).column.id);
      return;
    }
    const top = scroll.getBoundingClientRect().top + navigation.offsetHeight + 16;
    let current = first.column.id;
    for (const { column } of visibleSections) {
      const section = sectionRefs.current.get(column.id);
      if (section && section.getBoundingClientRect().top <= top) {
        current = column.id;
      }
    }
    setActiveId(current);
  });

  const revealSection = useStableCallback((columnId: string) => {
    const scroll = scrollRef.current;
    const section = sectionRefs.current.get(columnId);
    if (!(scroll && section)) {
      return;
    }
    const top =
      scroll.scrollTop +
      section.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      (navigationRef.current?.offsetHeight ?? 0) -
      12;
    scroll.scrollTo?.({ top: Math.max(0, top), behavior: 'instant' });
    navigationTarget.current = { columnId, scrollTop: scroll.scrollTop };
    if (!section.contains(section.ownerDocument.activeElement)) {
      section.focus({ preventScroll: true });
    }
    setActiveId(columnId);
  });

  useEffect(() => {
    updateActiveSection(sections);
  }, [sections]);

  useEffect(() => {
    if (!showInlineForm) {
      lastRevealedFormRequest.current = null;
    } else if (lastRevealedFormRequest.current !== inlineFormRequest) {
      lastRevealedFormRequest.current = inlineFormRequest;
      revealSection('ISSUES');
    }
  }, [showInlineForm, inlineFormRequest]);

  useEffect(() => {
    if (workspaceCreationRequest > lastCreationRequest.current) {
      revealSection('WORKING');
    }
    lastCreationRequest.current = workspaceCreationRequest;
  }, [workspaceCreationRequest]);

  return (
    <div
      ref={scrollRef}
      data-mobile-board
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={() => updateActiveSection(sections)}
    >
      <nav
        ref={navigationRef}
        aria-label="Board sections"
        className="sticky top-0 z-10 grid grid-cols-4 border-b bg-background"
      >
        {sections.map(({ column, count, visible }) => (
          <a
            key={column.id}
            href={`#${id}-${column.id}`}
            aria-current={visible && activeId === column.id ? 'location' : undefined}
            aria-disabled={!visible}
            onClick={(event) => {
              event.preventDefault();
              if (visible) {
                revealSection(column.id);
              }
            }}
            className={cn(
              'flex h-10 min-w-0 items-center justify-center gap-1 border-b-2 px-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              visible && activeId === column.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground',
              !visible && 'opacity-50'
            )}
          >
            {column.shortLabel ?? column.label}{' '}
            <Badge variant="outline" size="count" className="text-inherit">
              {count}
            </Badge>
          </a>
        ))}
      </nav>
      {/* Keep card controls in a stacking context below the sticky navigation. */}
      <div className="isolate flex flex-col gap-4 pt-3 pb-4">
        {visibleSections.map(({ column, content }) => (
          <section
            key={column.id}
            id={`${id}-${column.id}`}
            aria-label={column.shortLabel ?? column.label}
            tabIndex={-1}
            ref={(element) => {
              if (element) {
                sectionRefs.current.set(column.id, element);
              } else {
                sectionRefs.current.delete(column.id);
              }
            }}
            className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </section>
        ))}
      </div>
    </div>
  );
}
