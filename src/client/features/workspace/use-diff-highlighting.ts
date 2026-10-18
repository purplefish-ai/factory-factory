import { useEffect, useMemo, useState } from 'react';
import type { LineTokenMap, PrismStylesheet } from '@/lib/diff/syntax-highlight';
import type { DiffLine } from '@/lib/diff/types';
import { diffHighlightResponseSchema } from './diff-highlight-protocol';

type HighlightRequest = { language: string; theme: PrismStylesheet } & (
  | { lines: DiffLine[] }
  | { content: string; cssClasses: true }
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
  return useHighlighting(request, enabled && lines.length > 0).tokens;
}

const fileStylesheet: PrismStylesheet = {};

export function useFileHighlighting(content: string, language: string, enabled = true) {
  const request = useMemo(
    () => ({ content, language, theme: fileStylesheet, cssClasses: true as const }),
    [content, language]
  );
  return useHighlighting(request, enabled && content.length > 0);
}

function useHighlighting(request: HighlightRequest, enabled: boolean) {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    if (!enabled || request.language === 'text') {
      return;
    }
    let active = true;
    let worker: Worker | undefined;
    const finish = (tokens: LineTokenMap | null) => {
      if (active) {
        setResult({ request, tokens });
      }
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('./diff-highlight.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!active) {
          return;
        }
        const parsed = diffHighlightResponseSchema.safeParse(event.data);
        finish(parsed.success ? parsed.data : null);
      };
      worker.onerror = () => finish(null);
      worker.onmessageerror = () => finish(null);
      worker.postMessage(request);
    } catch {
      finish(null);
    }
    return () => {
      active = false;
      worker?.terminate();
    };
  }, [enabled, request]);

  const finished = result?.request === request;
  return {
    tokens: enabled && finished ? result.tokens : null,
    pending: enabled && request.language !== 'text' && !finished,
  };
}
