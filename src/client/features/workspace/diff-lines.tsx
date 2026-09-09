import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useMemo } from 'react';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import { getDiffLineBackground, getDiffLinePrefix, getDiffLineTextColor } from '@/lib/diff/styles';
import type { LineTokenMap, SyntaxToken } from '@/lib/diff/syntax-highlight';
import type { DiffLine } from '@/lib/diff/types';
import { cn } from '@/lib/utils';
import type { ScrollState } from './scroll-state';
import { useDiffScroll } from './use-diff-scroll';

interface SyntaxHighlightedContentProps {
  tokens: SyntaxToken[];
}

function SyntaxHighlightedContent({ tokens }: SyntaxHighlightedContentProps) {
  return (
    <>
      {tokens.map((token, i) => {
        const key = `${i}-${token.content.length}`;
        return (
          <span key={key} style={token.style}>
            {token.content}
          </span>
        );
      })}
    </>
  );
}

interface DiffLineProps {
  line: DiffLine;
  lineNumberWidth: number;
  tokens?: SyntaxToken[] | null;
}

function DiffLineComponent({ line, lineNumberWidth, tokens }: DiffLineProps) {
  const bgColor = getDiffLineBackground(line.type);
  const prefix = getDiffLinePrefix(line.type);
  const hasTokens = tokens != null && tokens.length > 0;
  // When syntax tokens are available, let them control text color for code lines.
  // Header/hunk lines and lines without tokens use the standard diff text color.
  const textColor = hasTokens ? undefined : getDiffLineTextColor(line.type);

  return (
    <div className={cn('flex min-w-0 font-mono text-xs', bgColor)}>
      {/* Line numbers */}
      <div className="flex-shrink-0 flex text-muted-foreground border-r border-border select-none">
        <span
          className="box-content px-1 text-right border-r border-border tabular-nums"
          style={{ width: `${lineNumberWidth}ch` }}
        >
          {line.lineNumber?.old ?? ''}
        </span>
        <span
          className="box-content px-1 text-right tabular-nums"
          style={{ width: `${lineNumberWidth}ch` }}
        >
          {line.lineNumber?.new ?? ''}
        </span>
      </div>

      {/* Prefix — always uses diff text color */}
      <span
        className={cn('flex-shrink-0 w-4 text-center select-none', getDiffLineTextColor(line.type))}
      >
        {prefix}
      </span>

      {/* Content */}
      <pre className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all px-2', textColor)}>
        {hasTokens ? <SyntaxHighlightedContent tokens={tokens} /> : line.content}
      </pre>
    </div>
  );
}

export interface DiffLinesProps {
  lines: DiffLine[];
  lineNumberWidth: number;
  tokenMap: LineTokenMap | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollState?: ScrollState | null;
  onScrollStateChange?: (state: ScrollState) => void;
}

/** Render small diffs normally; measure only visible rows in large, wrapping diffs. */
export function DiffLines({
  lines,
  lineNumberWidth,
  tokenMap,
  scrollContainerRef,
  scrollState,
  onScrollStateChange,
}: DiffLinesProps) {
  const virtualized = lines.length > 200;
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 16,
    overscan: 8,
    enabled: virtualized,
  });

  const measurementVersion = useDiffScroll({
    lines,
    virtualizer,
    virtualized,
    scrollContainerRef,
    scrollState,
    onScrollStateChange,
  });

  const smallRows = useMemo(
    () =>
      virtualized
        ? []
        : withOccurrenceKeys(lines, (line) =>
            JSON.stringify([line.type, line.lineNumber?.old, line.lineNumber?.new, line.content])
          ),
    [lines, virtualized]
  );

  if (!virtualized) {
    return smallRows.map(({ item: line, key }, index) => (
      <DiffLineComponent
        key={key}
        line={line}
        lineNumberWidth={lineNumberWidth}
        tokens={tokenMap?.get(index)}
      />
    ));
  }

  return (
    <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
      {virtualizer.getVirtualItems().map((row) => {
        const line = lines[row.index];
        if (!line) {
          return null;
        }
        return (
          <div
            key={`${measurementVersion}-${row.key}`}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${row.start}px)`,
            }}
          >
            <DiffLineComponent
              line={line}
              lineNumberWidth={lineNumberWidth}
              tokens={tokenMap?.get(row.index)}
            />
          </div>
        );
      })}
    </div>
  );
}
