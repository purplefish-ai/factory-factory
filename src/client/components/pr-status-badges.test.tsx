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

    expect(markup).toContain('text-gray-400');
    expect(markup).toContain('text-gray-500');
    expect(markup).toContain('text-red-500');
    expect(markup).toContain('text-red-600');
    expect(markup).toContain('text-green-500');
    expect(markup).toContain('text-green-600');
    expect(markup).toContain('○');
    expect(markup).toContain('✗');
    expect(markup).toContain('✓');
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
