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
  it('renders reasoning text with markdown formatting', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: '**Testing API calls with escalation**',
        })
      );
    });

    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('Testing API calls with escalation');
    expect(container.textContent).not.toContain('**Testing API calls with escalation**');

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

  it('avoids malformed markdown when truncation cuts through syntax', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'a'.repeat(190)} **broken markdown that should be truncated safely**`,
        })
      );
    });

    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('...');
    expect(container.textContent).not.toContain('**');

    root.unmount();
  });

  it('removes dangling underscore markdown when truncation cuts mid-token', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'b'.repeat(190)} _broken emphasis that should be truncated safely_`,
        })
      );
    });

    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('...');
    expect(container.textContent).not.toContain('_');

    root.unmount();
  });

  it('removes dangling strikethrough markdown when truncation cuts mid-token', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'c'.repeat(190)} ~~broken strikethrough that should be truncated safely~~`,
        })
      );
    });

    expect(container.querySelector('del')).toBeNull();
    expect(container.textContent).toContain('...');
    expect(container.textContent).not.toContain('~~');

    root.unmount();
  });

  it('preserves parentheses when truncation includes unmatched literal punctuation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'d'.repeat(150)} processData(input) ${'e'.repeat(43)} (`,
        })
      );
    });

    expect(container.textContent).toContain('processData(input)');
    expect(container.textContent).not.toContain('processDatainput');

    root.unmount();
  });

  it('keeps balanced markdown formatting when truncated text ends with a marker character', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'f'.repeat(190)} **ok** additional trailing text`,
        })
      );
    });

    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('ok');

    root.unmount();
  });

  it('preserves literal math and identifier characters when fallback sanitizes markdown', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'g'.repeat(120)} 5 * 3 = 15 my_var ${'h'.repeat(60)} **broken`,
        })
      );
    });

    expect(container.textContent).toContain('5 * 3 = 15');
    expect(container.textContent).toContain('my_var');
    expect(container.textContent).not.toContain('**broken');

    root.unmount();
  });
});
