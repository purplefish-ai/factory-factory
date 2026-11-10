import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusChip, StatusDot, StatusIcon } from './status-indicators';

describe('StatusDot', () => {
  it('uses the tone token and pulses only for live work by default', () => {
    const working = renderToStaticMarkup(createElement(StatusDot, { tone: 'working' }));
    expect(working).toContain('bg-running');
    expect(working).toContain('animate-pulse');
    expect(working).toContain('motion-reduce:animate-none');

    const waiting = renderToStaticMarkup(createElement(StatusDot, { tone: 'waiting' }));
    expect(waiting).toContain('bg-info');
    expect(waiting).not.toContain('animate-pulse');
  });

  it('is decorative unless labelled', () => {
    expect(renderToStaticMarkup(createElement(StatusDot, { tone: 'success' }))).toContain(
      'aria-hidden="true"'
    );
    const labelled = renderToStaticMarkup(
      createElement(StatusDot, { tone: 'danger', label: 'CI failed' })
    );
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="CI failed"');
  });

  it('lets callers override the default animation', () => {
    expect(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'waiting', pulse: true }))
    ).toContain('animate-pulse');
    expect(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'working', pulse: false }))
    ).not.toContain('animate-pulse');
  });
});

describe('StatusChip', () => {
  it('renders a tinted chip with the label', () => {
    const markup = renderToStaticMarkup(<StatusChip tone="merged">Merged</StatusChip>);
    expect(markup).toContain('bg-merged/10');
    expect(markup).toContain('text-merged');
    expect(markup).toContain('>Merged<');
    expect(markup).not.toContain('<svg');
  });

  it('uses the 2xs step at the small size and passes span attributes through', () => {
    const markup = renderToStaticMarkup(
      <StatusChip tone="info" role="img" aria-label="3 unread" title="3 unread" data-testid="chip">
        3
      </StatusChip>
    );
    expect(markup).toContain('text-2xs');
    expect(markup).not.toMatch(/text-\[\d+px\]/);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="3 unread"');
    expect(markup).toContain('data-testid="chip"');
    expect(markup).toContain('data-status-tone="info"');
  });

  it('can show the tone icon', () => {
    const markup = renderToStaticMarkup(
      <StatusChip tone="success" icon>
        Passing
      </StatusChip>
    );
    expect(markup).toContain('<svg');
  });
});

describe('StatusIcon', () => {
  it('colors a specific icon with the tone', () => {
    const markup = renderToStaticMarkup(
      createElement(StatusIcon, { tone: 'attention', icon: ShieldWarningIcon })
    );
    expect(markup).toContain('text-warning');
    expect(markup).toContain('data-status-tone="attention"');
  });
});
