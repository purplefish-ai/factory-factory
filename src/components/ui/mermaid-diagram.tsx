import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';

// Initialize mermaid with strict security
if (typeof window !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'strict',
    suppressErrorRendering: true,
  });
}

// Component to render Mermaid diagrams
export default function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!(ref.current && chart)) {
      return;
    }
    let cancelled = false;
    const renderDiagram = async () => {
      try {
        setError(null);
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        // Capture the actual error message for debugging
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
      }
    };
    void renderDiagram();
    return () => {
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
