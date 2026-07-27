// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadingIndicator } from './assistant-message-renderer';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('LoadingIndicator', () => {
  it('renders reasoning text as plain text with markdown stripped', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: '**Testing** `API` ~~calls~~ with _escalation_',
        })
      );
    });

    expect(container.textContent).toContain('Testing API calls with escalation');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
    expect(container.textContent).not.toContain('~~');
    expect(container.querySelector('strong')).toBeNull();

    root.unmount();
  });

  it('shows fallback loading text when reasoning is empty', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(LoadingIndicator, { latestReasoning: null }));
    });

    expect(container.textContent).toContain('Agent is working...');

    root.unmount();
  });

  it('strips markdown links to plain text', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: 'Read [the docs](https://example.com/docs) before running this.',
        })
      );
    });

    expect(container.textContent).toContain('Read the docs before running this.');
    expect(container.textContent).not.toContain('[');
    expect(container.textContent).not.toContain('https://example.com/docs');

    root.unmount();
  });

  it('truncates long stripped text to 200 chars with ellipsis', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'a'.repeat(190)} **bold** ${'b'.repeat(40)}`,
        })
      );
    });

    expect(container.textContent).toContain('...');
    expect(container.textContent?.length).toBeLessThanOrEqual(200);
    expect(container.textContent).not.toContain('**');

    root.unmount();
  });

  it('shows fallback text when markdown-only input strips to empty content', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: '***~~~```',
        })
      );
    });

    expect(container.textContent).toContain('Agent is working...');

    root.unmount();
  });

  it('removes dangling underscores from unmatched markdown tokens', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: 'Working through ___partial markdown',
        })
      );
    });

    expect(container.textContent).toContain('Working through partial markdown');
    expect(container.textContent).not.toContain('_');

    root.unmount();
  });
});
