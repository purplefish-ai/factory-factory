'use client';

import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Override code rendering - in react-markdown v10, inline code is not wrapped in <pre>
          code: ({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) => {
            // Check if this is a code block (has language class) or inline code
            const hasLanguage = className?.startsWith('language-');
            if (hasLanguage) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            // Inline code
            return (
              <code className="bg-muted px-1.5 py-0.5 rounded text-sm" {...props}>
                {children}
              </code>
            );
          },
          // Override pre for code blocks
          pre: ({ children, ...props }: ComponentPropsWithoutRef<'pre'>) => (
            <pre className="bg-muted p-3 rounded-md overflow-x-auto" {...props}>
              {children}
            </pre>
          ),
          // Override link rendering
          a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline"
            >
              {children}
            </a>
          ),
          // Override paragraph to avoid extra margins
          p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
            <p className="mb-2 last:mb-0">{children}</p>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
