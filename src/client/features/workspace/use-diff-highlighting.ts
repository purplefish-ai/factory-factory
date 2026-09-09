import { useEffect, useState } from 'react';
import type { LineTokenMap, PrismStylesheet } from '@/lib/diff/syntax-highlight';
import type { DiffLine } from '@/lib/diff/types';
import { diffHighlightResponseSchema } from './diff-highlight-protocol';

interface HighlightResult {
  lines: DiffLine[];
  language: string;
  theme: PrismStylesheet;
  tokens: LineTokenMap | null;
}

/** Plain text remains usable while highlighting runs, or if workers are unavailable. */
export function useDiffHighlighting(
  lines: DiffLine[],
  language: string,
  theme: PrismStylesheet,
  enabled = true
): LineTokenMap | null {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    if (!enabled || lines.length === 0 || language === 'text') {
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
        setResult({ lines, language, theme, tokens: parsed.success ? parsed.data : null });
        worker?.terminate();
      };
      worker.onerror = () => worker?.terminate();
      worker.onmessageerror = () => worker?.terminate();
      worker.postMessage({ lines, language, theme });
    } catch {
      worker?.terminate();
    }
    return () => {
      active = false;
      worker?.terminate();
    };
  }, [enabled, lines, language, theme]);

  return enabled &&
    result?.lines === lines &&
    result.language === language &&
    result.theme === theme
    ? result.tokens
    : null;
}
