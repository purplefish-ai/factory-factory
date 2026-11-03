import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useCallback,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from '@/lib/markdown-blocks';
import { cn } from '@/lib/utils';

const MermaidDiagram = lazy(() => import('./mermaid-diagram'));

const REMARK_PLUGINS = [remarkGfm];

// react-markdown percent-encodes backslashes, so `C:\repo` arrives as `C:%5Crepo`.
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|%5C)/i;

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
  renderExternalLink?: (link: ReactElement<ComponentPropsWithoutRef<'a'>>) => ReactNode;
  /**
   * Content is still growing. Top-level blocks parse independently, so only the
   * changed tail block re-parses. Output matches the single-block render.
   */
  streaming?: boolean;
  renderImage?: (image: { src?: string; alt?: string; title?: string }) => ReactNode;
}

type MarkdownComponents = NonNullable<ComponentPropsWithoutRef<typeof ReactMarkdown>['components']>;

const MarkdownBlock = memo(function MarkdownBlock({
  content,
  components,
  urlTransform,
}: {
  content: string;
  components: MarkdownComponents;
  urlTransform: NonNullable<ComponentPropsWithoutRef<typeof ReactMarkdown>['urlTransform']>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={components}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  );
});

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
  renderExternalLink,
  streaming = false,
  renderImage,
}: MarkdownRendererProps) {
  // Memoize the markdown components to prevent recreating on every render
  const components = useMemo<MarkdownComponents>(
    () => ({
      ...(renderImage
        ? {
            img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) =>
              renderImage({ src, alt, title }),
          }
        : {}),
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

        const link = (
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
        return renderExternalLink ? renderExternalLink(link) : link;
      },
      // Override paragraph with comfortable spacing
      p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
        <p className="mb-4 last:mb-0">{children}</p>
      ),
    }),
    [onWorkspaceFileLink, resolveWorkspaceFileLink, renderExternalLink, renderImage]
  );

  // Custom image renderers own source validation and local-path resolution.
  // `defaultUrlTransform` blanks `C:` as an unknown protocol. Keep drive paths
  // that resolve to a workspace file so the link handler can open them;
  // everything else, including `javascript:`, goes through the default.
  const urlTransform = useCallback(
    (url: string, key: string) =>
      (key === 'src' && renderImage) ||
      (onWorkspaceFileLink && WINDOWS_DRIVE_PATH.test(url) && resolveWorkspaceFileLink?.(url))
        ? url
        : defaultUrlTransform(url),
    [onWorkspaceFileLink, resolveWorkspaceFileLink, renderImage]
  );

  const blocks = useMemo(() => {
    let start = 0;
    return (streaming ? splitMarkdownBlocks(content) : [content]).map((text) => {
      const block = { start, text };
      start += text.length;
      return block;
    });
  }, [content, streaming]);

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-hidden break-words text-sm leading-loose [&_a]:break-all [&_li]:break-words [&_p]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto',
        className
      )}
    >
      {blocks.map(({ start, text }) => (
        // Earlier blocks keep their start offsets as the tail grows, so they stay memoized.
        <MarkdownBlock
          key={start}
          content={text}
          components={components}
          urlTransform={urlTransform}
        />
      ))}
    </div>
  );
});
