// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ThinkingFooter } from './thinking-footer';

describe('ThinkingFooter', () => {
  it('shows fallback activity and makes the full long preview available outside layout', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<ThinkingFooter active latestThinking={null} />));
      expect(host.textContent).toContain('Agent is working...');
      const text = 'A long thinking preview. '.repeat(40);
      flushSync(() => root.render(<ThinkingFooter active latestThinking={text} />));
      const trigger = host.querySelector('button');
      flushSync(() => trigger?.click());
      expect(document.querySelector('[data-slot="popover-content"]')?.textContent).toContain(
        text.trim()
      );
      flushSync(() => root.render(<ThinkingFooter active={false} latestThinking={null} />));
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
      expect(host.querySelector('[inert]')).not.toBeNull();
      expect(host.querySelector('[aria-hidden="true"]')).toBeNull();
      expect(host.querySelector('button')?.disabled).toBe(true);
      expect(host.querySelector('button')?.tabIndex).toBe(-1);
      flushSync(() => root.render(<ThinkingFooter active latestThinking="Next turn" />));
      expect(host.querySelector('[inert]')).toBeNull();
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });
});
