import { type ComponentProps, useMemo, useState, useSyncExternalStore } from 'react';
import { type AnimateOptions, type Components, Streamdown } from 'streamdown';
import type { MarkdownContentProps } from '@/components/ui/markdown';

const ANIMATION: AnimateOptions = { animation: 'fadeIn', duration: 120, sep: 'word', stagger: 0 };
const REHYPE_PLUGINS: NonNullable<ComponentProps<typeof Streamdown>['rehypePlugins']> = [];
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
// Keep typography owned by our prose wrapper instead of Streamdown's styled
// defaults (including its span-based strong and interactive table components).
const SEMANTIC_COMPONENTS = {
  a: 'a',
  blockquote: 'blockquote',
  code: 'code',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
  img: 'img',
  li: 'li',
  ol: 'ol',
  p: 'p',
  pre: 'pre',
  section: 'section',
  strong: 'strong',
  sub: 'sub',
  sup: 'sup',
  table: 'table',
  tbody: 'tbody',
  td: 'td',
  th: 'th',
  thead: 'thead',
  tr: 'tr',
  ul: 'ul',
} satisfies Components;

function subscribeMotion(onChange: () => void) {
  const media = window.matchMedia?.(MOTION_QUERY);
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}

function getReducedMotion() {
  return window.matchMedia?.(MOTION_QUERY).matches ?? true;
}

function StreamdownContent({ content, streaming, components, urlTransform }: MarkdownContentProps) {
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReducedMotion, () => true);
  const renderers = useMemo(() => ({ ...SEMANTIC_COMPONENTS, ...components }), [components]);
  // Streamdown's root memo ignores components/urlTransform changes. Remount
  // only when those options change so old workspace callbacks cannot survive.
  const [configuration, setConfiguration] = useState({ components, urlTransform, revision: 0 });
  if (configuration.components !== components || configuration.urlTransform !== urlTransform) {
    setConfiguration({ components, urlTransform, revision: configuration.revision + 1 });
  }

  return (
    <Streamdown
      key={configuration.revision}
      components={renderers}
      urlTransform={urlTransform}
      // Match react-markdown's literal HTML and application-owned URL/image
      // handling instead of Streamdown's raw-HTML and URL-rewriting defaults.
      rehypePlugins={REHYPE_PLUGINS}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      animated={reducedMotion ? false : ANIMATION}
      controls={false}
    >
      {content}
    </Streamdown>
  );
}

/** Streamdown parser sharing the application's Markdown rendering policy. */
export function renderStreamdownContent(props: MarkdownContentProps) {
  return <StreamdownContent {...props} />;
}
