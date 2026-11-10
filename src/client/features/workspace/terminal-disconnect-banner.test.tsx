import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';

describe('TerminalDisconnectBanner', () => {
  it('announces the disconnect in a polite status region', () => {
    const markup = renderToStaticMarkup(
      <TerminalDisconnectBanner gaveUp={false} onReconnect={() => undefined} />
    );
    expect(markup).toMatch(/<output[^>]*>Terminal disconnected — reconnecting/);
    expect(markup).not.toContain('Reconnect<');
  });

  it('offers a manual reconnect once the transport gives up', () => {
    const markup = renderToStaticMarkup(
      <TerminalDisconnectBanner gaveUp onReconnect={() => undefined} />
    );
    expect(markup).toMatch(/<output[^>]*>Terminal disconnected\. Input will not be delivered/);
    expect(markup).toContain('>Reconnect</button>');
  });

  it('uses the active theme warning tokens without forcing dark mode', () => {
    const markup = renderToStaticMarkup(
      <TerminalDisconnectBanner gaveUp onReconnect={() => undefined} />
    );
    // No element forces the `dark` class; `dark:` variants follow the active mode.
    expect(markup).not.toMatch(/class="(?:[^"]*\s)?dark(?:\s[^"]*)?"/);
    expect(markup).toContain('dark:bg-warning/10');
    expect(markup).toContain('text-warning');
    expect(markup).not.toMatch(/\b(?:bg|text|border)-amber-\d/);
  });
});
