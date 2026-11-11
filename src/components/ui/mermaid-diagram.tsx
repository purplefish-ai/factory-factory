import { useEffect, useRef, useState } from 'react';
import { StatusCallout } from '@/client/components/status-callout';
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
        const svg = await renderThemedMermaid(chart, element, isStale);
        if (!isStale() && ref.current && svg) {
          ref.current.innerHTML = svg;
          setError(null);
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
        <StatusCallout tone="danger" title="Error rendering diagram" className="my-4">
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{error}</pre>
        </StatusCallout>
      )}
    </>
  );
}
