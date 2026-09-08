import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';

// Initialize mermaid with strict security
if (typeof window !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'strict',
  });
}

// Component to render Mermaid diagrams
export default function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ref.current && chart) {
      const renderDiagram = async () => {
        try {
          setError(null);
          const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
          const { svg } = await mermaid.render(id, chart);
          if (ref.current) {
            ref.current.innerHTML = svg;
          }
        } catch (err) {
          // Capture the actual error message for debugging
          const errorMessage = err instanceof Error ? err.message : String(err);
          setError(errorMessage);
        }
      };
      void renderDiagram();
    }
  }, [chart]);

  if (error) {
    return (
      <div className="my-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
        <div className="text-destructive text-sm font-medium mb-2">Error rendering diagram:</div>
        <pre className="text-destructive text-xs overflow-x-auto whitespace-pre-wrap">{error}</pre>
      </div>
    );
  }

  return <div ref={ref} className="my-4" />;
}
