import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';

describe('TerminalDisconnectBanner', () => {
  it('announces the disconnect in a polite status region', () => {
    const markup = renderToStaticMarkup(<TerminalDisconnectBanner />);
    expect(markup).toMatch(/<output[^>]*>Terminal disconnected — reconnecting/);
    // The transport never stops retrying, so there is no manual reconnect.
    expect(markup).not.toContain('<button');
  });

  it('uses the active theme warning tokens without forcing dark mode', () => {
    const markup = renderToStaticMarkup(<TerminalDisconnectBanner />);
    // No element forces the `dark` class; `dark:` variants follow the active mode.
    expect(markup).not.toMatch(/class="(?:[^"]*\s)?dark(?:\s[^"]*)?"/);
    expect(markup).toContain('dark:bg-warning/10');
    expect(markup).toContain('text-warning');
    expect(markup).not.toMatch(/\b(?:bg|text|border)-amber-\d/);
  });
});
