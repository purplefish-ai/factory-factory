import type { Virtualizer } from '@tanstack/react-virtual';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { useTranscriptLayout } from './transcript-layout';
import { TranscriptRows } from './transcript-rows';

/** Renderer-only tests expose every row; geometry is exercised in Playwright. */
export function TranscriptRenderingFixture(props: TranscriptDisplayProps) {
  const layout = useTranscriptLayout(props, false);
  const engine = {
    getVirtualItems: () =>
      layout.keys.map((key, index) => ({
        key,
        index,
        start: index * 80,
        size: 80,
        end: (index + 1) * 80,
        lane: 0,
      })),
    measureElement: () => undefined,
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>;
  // Queued message actions render tooltips, which the app root provides.
  return (
    <TooltipProvider>
      <TranscriptRows
        display={props}
        layout={layout}
        engine={engine}
        totalSize={layout.keys.length * 80}
      />
    </TooltipProvider>
  );
}
