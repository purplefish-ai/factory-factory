'use client';

import { ExternalLink } from 'lucide-react';
import mermaid from 'mermaid';
import type React from 'react';
import { type ComponentPropsWithoutRef, memo, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Initialize mermaid with strict security
if (typeof window !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'strict',
  });
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Component to render Mermaid diagrams
function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);

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
        } catch {
          // Safely handle error without innerHTML injection
          setError('Error rendering diagram');
        }
      };
      renderDiagram();
    }
  }, [chart]);

  if (error) {
    return (
      <div className="my-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
        <pre className="text-destructive text-xs">{error}</pre>
      </div>
    );
  }

  return <div ref={ref} className="my-4" />;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  // Memoize the markdown components to prevent recreating on every render
  const components = useMemo(
    () => ({
      // Override code rendering - in react-markdown v10, inline code is not wrapped in <pre>
      code: ({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) => {
        // Check if this is a code block (has language class) or inline code
        const hasLanguage = className?.startsWith('language-');
        const language = className?.replace('language-', '');

        if (hasLanguage) {
          // Check if it's a Mermaid diagram
          if (language === 'mermaid') {
            return <MermaidDiagram chart={String(children).trim()} />;
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }
        // Inline code
        return (
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs" {...props}>
            {children}
          </code>
        );
      },
      // Override pre for code blocks
      pre: ({ children, ...props }: ComponentPropsWithoutRef<'pre'>) => {
        // Check if the child is a Mermaid diagram
        const child = children as React.ReactElement | undefined;
        if (child?.props?.className?.includes('language-mermaid')) {
          return <>{children}</>;
        }
        return (
          <pre className="bg-muted p-3 rounded-md overflow-x-auto" {...props}>
            {children}
          </pre>
        );
      },
      // Override link rendering
      a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:no-underline inline-flex items-center gap-0.5"
        >
          {children}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ),
      // Override paragraph with comfortable spacing
      p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
        <p className="mb-4 last:mb-0">{children}</p>
      ),
    }),
    []
  );

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none break-words text-sm leading-loose',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
