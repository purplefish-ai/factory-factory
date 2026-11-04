import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CIChecksSection, CIStatusBadge } from './pr-status-badges';

function createCheck(
  name: string,
  conclusion: 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'CANCELLED' | 'NEUTRAL',
  detailsUrl?: string
) {
  return {
    __typename: 'CheckRun' as const,
    name,
    status: 'COMPLETED' as const,
    conclusion,
    detailsUrl,
  };
}

describe('CIChecksSection', () => {
  it('renders skipped, cancelled, and neutral checks with their derived states', () => {
    const markup = renderToStaticMarkup(
      <CIChecksSection
        checks={[
          createCheck('lint', 'SKIPPED'),
          createCheck('build', 'CANCELLED'),
          createCheck('coverage', 'NEUTRAL'),
        ]}
      />
    );

    // Each check maps to a status tone (skipped → neutral, cancelled → danger,
    // neutral → success) rendered with theme tokens and a humanized label.
    expect(markup).toContain('data-status-tone="neutral"');
    expect(markup).toContain('data-status-tone="danger"');
    expect(markup).toContain('data-status-tone="success"');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).toContain('text-destructive');
    expect(markup).toContain('text-success');
    expect(markup).toContain('>Skipped<');
    expect(markup).toContain('>Cancelled<');
    expect(markup).toContain('>Neutral<');
    expect(markup).not.toMatch(/\b(?:text|bg)-(?:gray|red|green|yellow)-\d/);
  });

  it('humanizes check progress and conclusions', () => {
    const markup = renderToStaticMarkup(
      <CIChecksSection
        checks={[
          { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
          createCheck('deploy', 'FAILURE'),
          { __typename: 'CheckRun', name: 'slow', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        ]}
      />
    );

    expect(markup).toContain('>Running<');
    expect(markup).toContain('>Failure<');
    expect(markup).toContain('>Timed out<');
    expect(markup).not.toContain('TIMED_OUT');
    expect(markup).toContain('data-status-tone="waiting"');
  });

  it('counts cancelled as failed and neutral as passed in section summary', () => {
    const markup = renderToStaticMarkup(
      <CIChecksSection
        checks={[
          createCheck('typecheck', 'SUCCESS'),
          createCheck('lint', 'SKIPPED'),
          createCheck('build', 'CANCELLED'),
          createCheck('audit', 'NEUTRAL'),
        ]}
      />
    );

    expect(markup).toContain('2 passed');
    expect(markup).toContain('1 failed');
    expect(markup).toContain('1 skipped');
    expect(markup).not.toContain('4 passed');
  });
});

describe('CIStatusBadge', () => {
  it('shows failed when any check is cancelled', () => {
    const markup = renderToStaticMarkup(
      <CIStatusBadge
        checks={[
          createCheck('typecheck', 'SUCCESS'),
          createCheck('lint', 'SKIPPED'),
          createCheck('build', 'CANCELLED'),
          createCheck('audit', 'NEUTRAL'),
        ]}
      />
    );

    expect(markup).toContain('1 failed');
    expect(markup).not.toContain('4 passed');
  });

  it('shows failed when all terminal checks include a cancellation', () => {
    const markup = renderToStaticMarkup(
      <CIStatusBadge
        checks={[
          createCheck('lint', 'SKIPPED'),
          createCheck('build', 'CANCELLED'),
          createCheck('audit', 'NEUTRAL'),
        ]}
      />
    );

    expect(markup).toContain('1 failed');
    expect(markup).not.toContain('0 passed');
  });

  it('prefers latest successful rerun over an earlier cancelled duplicate check run', () => {
    const markup = renderToStaticMarkup(
      <CIStatusBadge
        checks={[
          createCheck('build', 'CANCELLED', 'https://github.com/org/repo/actions/runs/100'),
          createCheck('build', 'SUCCESS', 'https://github.com/org/repo/actions/runs/101'),
        ]}
      />
    );

    expect(markup).toContain('1 passed');
    expect(markup).not.toContain('1 failed');
  });

  it('uses failure priority for duplicate check names without run metadata', () => {
    const markup = renderToStaticMarkup(
      <CIStatusBadge
        checks={[createCheck('build', 'CANCELLED'), createCheck('build', 'SUCCESS')]}
      />
    );

    expect(markup).toContain('1 failed');
    expect(markup).not.toContain('1 skipped');
  });
});
