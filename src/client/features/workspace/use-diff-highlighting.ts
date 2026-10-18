import { useEffect, useMemo, useState } from 'react';
import type { LineTokenMap, PrismStylesheet } from '@/lib/diff/syntax-highlight';
import type { DiffLine } from '@/lib/diff/types';
import { diffHighlightResponseSchema } from './diff-highlight-protocol';

type HighlightRequest = { language: string; theme: PrismStylesheet } & (
  | { lines: DiffLine[] }
  | { content: string }
);
interface HighlightResult {
  request: HighlightRequest;
  tokens: LineTokenMap | null;
}

/** Plain text remains usable while highlighting runs, or if workers are unavailable. */
export function useDiffHighlighting(
  lines: DiffLine[],
  language: string,
  theme: PrismStylesheet,
  enabled = true
): LineTokenMap | null {
  const request = useMemo(() => ({ lines, language, theme }), [lines, language, theme]);
  return useHighlighting(request, enabled && lines.length > 0);
}

export function useFileHighlighting(
  content: string,
  language: string,
  theme: PrismStylesheet,
  enabled = true
) {
  const request = useMemo(() => ({ content, language, theme }), [content, language, theme]);
  return useHighlighting(request, enabled && content.length > 0);
}

function useHighlighting(request: HighlightRequest, enabled: boolean): LineTokenMap | null {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    if (!enabled || request.language === 'text') {
      return;
    }
    let active = true;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL('./diff-highlight.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!active) {
          return;
        }
        const parsed = diffHighlightResponseSchema.safeParse(event.data);
        setResult({ request, tokens: parsed.success ? parsed.data : null });
        worker?.terminate();
      };
      worker.onerror = () => worker?.terminate();
      worker.onmessageerror = () => worker?.terminate();
      worker.postMessage(request);
    } catch {
      worker?.terminate();
    }
    return () => {
      active = false;
      worker?.terminate();
    };
  }, [enabled, request]);

  return enabled && result?.request === request ? result.tokens : null;
}
