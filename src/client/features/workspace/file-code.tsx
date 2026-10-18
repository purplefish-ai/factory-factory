import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FILE_HIGHLIGHT_BLOCK_LINES,
  isFileBlockWithinByteBudget,
} from '@/lib/diff/file-highlight-limits';
import type { LineTokenMap, SyntaxToken } from '@/lib/diff/syntax-highlight';
import { useFileHighlighting } from './use-diff-highlighting';
import './file-code.css';

const plainLanguages = new Set(['text', 'plain', 'plaintext', 'txt']);

interface SourceBlock {
  firstLine: number;
  lines: string[];
  content: string;
  hasNext: boolean;
  withinByteBudget: boolean;
}

/** A token/visibility update must not replace nodes used by native find or selection. */
function afterTextSelection(element: HTMLElement, update: () => void): () => void {
  const document = element.ownerDocument;
  const apply = () => {
    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(element)
    ) {
      return;
    }
    document.removeEventListener('selectionchange', apply);
    update();
  };
  document.addEventListener('selectionchange', apply);
  apply();
  return () => document.removeEventListener('selectionchange', apply);
}

function SourceBlockView({
  block,
  tokens,
  language,
}: {
  block: SourceBlock;
  tokens: LineTokenMap | null;
  language: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [highlight, setHighlight] = useState<{ block: SourceBlock; tokens: LineTokenMap | null }>(
    () => ({ block, tokens: null })
  );
  const displayedTokens = highlight.block === block ? highlight.tokens : null;
  useEffect(() => {
    const next = visible ? tokens : null;
    if (highlight.block === block && highlight.tokens === next) {
      return;
    }
    const element = ref.current;
    if (!element) {
      return;
    }
    return afterTextSelection(element, () =>
      setHighlight((current) => {
        return current.block === block && current.tokens === next
          ? current
          : { block, tokens: next };
      })
    );
  }, [block, tokens, visible, highlight]);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const element = ref.current;
    let cancelPending: (() => void) | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        cancelPending?.();
        cancelPending = afterTextSelection(element, () =>
          setVisible(entry?.isIntersecting ?? false)
        );
      },
      { rootMargin: '300px' }
    );
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      cancelPending?.();
    };
  }, []);
  const renderTokens = (lineTokens: SyntaxToken[]) => {
    let offset = 0;
    return lineTokens.map((token) => {
      const key = offset;
      offset += token.content.length;
      return (
        <span key={key} className={token.className}>
          {token.content}
        </span>
      );
    });
  };
  return (
    <div ref={ref} style={{ display: 'flex', minHeight: `${block.lines.length * 1.5}em` }}>
      <span
        aria-hidden="true"
        className="react-syntax-highlighter-line-number select-none text-muted-foreground"
        style={{ flexShrink: 0, width: '4em', paddingRight: '1em', textAlign: 'right' }}
      >
        {block.lines.map((_, index) => block.firstLine + index).join('\n')}
      </span>
      <code className={`language-${language}`} style={{ fontFamily: 'var(--font-mono)' }}>
        {block.withinByteBudget && displayedTokens?.has(block.firstLine - 1)
          ? block.lines.map((line, index) => {
              const number = block.firstLine + index;
              const lineTokens = displayedTokens.get(number - 1);
              return (
                <span key={number}>
                  {lineTokens ? renderTokens(lineTokens) : line}
                  {index < block.lines.length - 1 || block.hasNext ? '\n' : ''}
                </span>
              );
            })
          : block.content}
      </code>
    </div>
  );
}

/** All source remains in the DOM; only nearby blocks expand into syntax spans. */
export function FileCode({
  content,
  language,
  theme,
}: {
  content: string;
  language: string;
  theme: 'dark' | 'light';
}) {
  const blocks = useMemo(() => {
    const lines = content.split('\n');
    const result: SourceBlock[] = [];
    for (let index = 0; index < lines.length; index += FILE_HIGHLIGHT_BLOCK_LINES) {
      const block = lines.slice(index, index + FILE_HIGHLIGHT_BLOCK_LINES);
      const blockContent =
        block.join('\n') + (index + FILE_HIGHLIGHT_BLOCK_LINES < lines.length ? '\n' : '');
      result.push({
        withinByteBudget: isFileBlockWithinByteBudget(blockContent),
        firstLine: index + 1,
        lines: block,
        hasNext: index + FILE_HIGHLIGHT_BLOCK_LINES < lines.length,
        content: blockContent,
      });
    }
    return result;
  }, [content]);
  const { tokens, pending } = useFileHighlighting(
    content,
    language,
    blocks.some((block) => block.withinByteBudget) && !plainLanguages.has(language.toLowerCase())
  );
  return (
    <pre
      className="file-code"
      data-syntax-theme={theme}
      aria-busy={pending}
      style={{
        margin: 0,
        padding: '1rem',
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
      }}
    >
      {blocks.map((block) => (
        <SourceBlockView key={block.firstLine} block={block} tokens={tokens} language={language} />
      ))}
    </pre>
  );
}
