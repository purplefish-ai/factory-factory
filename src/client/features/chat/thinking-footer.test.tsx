// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ThinkingFooter } from './thinking-footer';

describe('ThinkingFooter', () => {
  it('does not announce a retained request when activity is inactive', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(<ThinkingFooter active={false} waitingFor="permission_request" />)
      );
      expect(host.querySelector('[data-waiting-for]')).toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toBe('');
      expect(host.querySelector('[inert]')).not.toBeNull();
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it.each([
    ['permission_request', 'Waiting for your approval'],
    ['user_question', 'Waiting for your answer'],
    ['plan_approval', 'Waiting for your plan approval'],
  ] as const)('says the agent waits on a %s instead of working', (type, text) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(<ThinkingFooter active latestThinking="Checking CI" waitingFor={type} />)
      );
      const status = host.querySelector('[role="status"]');
      expect(status?.textContent).toBe(text);
      expect(status?.classList.contains('text-warning')).toBe(true);
      expect(host.textContent).not.toContain('Checking CI');
      expect(host.querySelector('button')).toBeNull();
      expect(host.querySelector('[data-testid="thinking-footer"]')?.className).toContain('h-8');
    } finally {
      root.unmount();
    }
  });

  it('returns to the thinking preview once the request resolves', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <ThinkingFooter active latestThinking="Running tests" waitingFor="permission_request" />
        )
      );
      flushSync(() =>
        root.render(<ThinkingFooter active latestThinking="Running tests" waitingFor={null} />)
      );
      expect(host.querySelector('button')?.textContent).toContain('Running tests');
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Agent is working');
    } finally {
      root.unmount();
    }
  });

  it('shows literal separators from the latest paragraph of fenced code', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <ThinkingFooter active latestThinking={'**Step**\n\n```text\n\n__init__\n\n---\n```'} />
        )
      );
      expect(host.querySelector('button')?.textContent).toBe('---');
    } finally {
      root.unmount();
    }
  });

  it.each(['**', '---'])('keeps the latest readable paragraph before a trailing %s', (marker) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(<ThinkingFooter active latestThinking={`**Checking CI**\n\n${marker}`} />)
      );
      expect(host.textContent).toContain('Checking CI');
      expect(host.textContent).not.toContain('Agent is working…');
    } finally {
      root.unmount();
    }
  });

  it('preserves identifiers, literal operators and bullet markers in readable reasoning', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <ThinkingFooter
            active
            latestThinking={
              '**Checking** user_id and MAX_RETRY_COUNT\n\n* inspect `__init__`\n* keep a*b*c'
            }
          />
        )
      );
      flushSync(() => host.querySelector('button')?.click());
      expect(document.querySelector('[data-slot="popover-content"]')?.textContent).toBe(
        'Checking user_id and MAX_RETRY_COUNT\n\n* inspect __init__\n* keep a*b*c'
      );
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  it('shows the latest paragraph inline and readable full reasoning in the popup', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <ThinkingFooter active latestThinking={'**Preparing PR body**\n\n**Checking** `CI`'} />
        )
      );
      expect(host.textContent).toContain('Checking CI');
      expect(host.textContent).not.toContain('Preparing PR body');
      flushSync(() => host.querySelector('button')?.click());
      const popup = document.querySelector('[data-slot="popover-content"]');
      expect(popup?.textContent).toBe('Preparing PR body\n\nChecking CI');
      expect(popup?.textContent).not.toContain('**');
      flushSync(() => root.render(<ThinkingFooter active latestThinking="**Current step**" />));
      expect(popup?.textContent).toBe('Current step');
      expect(host.textContent).not.toContain('Preparing PR body');
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  it('shows fallback activity and makes the full long preview available outside layout', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<ThinkingFooter active latestThinking={null} />));
      expect(host.textContent).toContain('Agent is working…');
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
