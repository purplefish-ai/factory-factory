import { ArrowSquareOutIcon, FileCodeIcon } from '@phosphor-icons/react';
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useMemo,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const MermaidDiagram = lazy(() => import('./mermaid-diagram'));

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
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
            return (
              <Suspense fallback={<pre className="my-4 overflow-x-auto">{children}</pre>}>
                <MermaidDiagram chart={String(children).trim()} />
              </Suspense>
            );
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
        const child = Array.isArray(children) ? children[0] : children;
        if (
          isValidElement<{ className?: string }>(child) &&
          typeof child.props.className === 'string' &&
          child.props.className.includes('language-mermaid')
        ) {
          return <>{children}</>;
        }
        return (
          <pre
            className="bg-muted text-foreground border border-border/70 p-3 rounded-md overflow-x-auto shadow-sm"
            {...props}
          >
            {children}
          </pre>
        );
      },
      // Override link rendering
      a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => {
        const workspacePath = href ? resolveWorkspaceFileLink?.(href) : null;
        if (workspacePath && onWorkspaceFileLink) {
          return (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onWorkspaceFileLink(workspacePath);
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) {
                  return;
                }

                event.preventDefault();
                onWorkspaceFileLink(workspacePath);
              }}
              className="text-primary underline hover:no-underline inline-flex items-center gap-0.5"
            >
              {children}
              <FileCodeIcon className="h-3 w-3 shrink-0" />
            </a>
          );
        }

        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:no-underline inline-flex items-center gap-0.5"
          >
            {children}
            <ArrowSquareOutIcon className="h-3 w-3 shrink-0" />
          </a>
        );
      },
      // Override paragraph with comfortable spacing
      p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
        <p className="mb-4 last:mb-0">{children}</p>
      ),
    }),
    [onWorkspaceFileLink, resolveWorkspaceFileLink]
  );

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-hidden break-words text-sm leading-loose [&_a]:break-all [&_li]:break-words [&_p]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
