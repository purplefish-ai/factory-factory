import { useEffect, useRef, useState } from 'react';
import { renderThemedMermaid } from '@/client/lib/mermaid-renderer';

// Component to render Mermaid diagrams
export default function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!(element && chart)) {
      return;
    }
    let cancelled = false;
    let revision = 0;
    const renderDiagram = async () => {
      const current = ++revision;
      const isStale = () => cancelled || current !== revision;
      try {
        setError(null);
        const svg = await renderThemedMermaid(chart, element, isStale);
        if (!isStale() && ref.current && svg) {
          ref.current.innerHTML = svg;
        }
      } catch (err) {
        if (isStale()) {
          return;
        }
        // Capture the actual error message for debugging
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
      }
    };
    const observer = new MutationObserver(() => {
      void renderDiagram();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-scheme'],
    });
    void renderDiagram();
    return () => {
      observer.disconnect();
      cancelled = true;
    };
  }, [chart]);

  return (
    <>
      <div ref={ref} className="my-4" hidden={Boolean(error)} />
      {error && (
        <div className="my-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
          <div className="text-destructive text-sm font-medium mb-2">Error rendering diagram:</div>
          <pre className="text-destructive text-xs overflow-x-auto whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      )}
    </>
  );
}
