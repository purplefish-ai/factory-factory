import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CIChecksSection, CIStatusBadge } from './pr-status-badges';

function createCheck(
  name: string,
  conclusion: 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'CANCELLED' | 'NEUTRAL'
) {
  return {
    __typename: 'CheckRun' as const,
    name,
    status: 'COMPLETED' as const,
    conclusion,
  };
}

describe('CIChecksSection', () => {
  it('renders skipped, cancelled, and neutral checks with neutral icon and text color', () => {
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
    expect(markup).toContain('○');
    expect(markup).not.toContain('✓');
  });

  it('does not count skipped, cancelled, and neutral checks as passed in section summary', () => {
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

    expect(markup).toContain('1 passed');
    expect(markup).toContain('3 skipped');
    expect(markup).not.toContain('3 passed');
  });
});

describe('CIStatusBadge', () => {
  it('does not count skipped, cancelled, or neutral checks as passed', () => {
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

    expect(markup).toContain('1 passed');
    expect(markup).not.toContain('4 passed');
  });

  it('shows skipped when all checks are non-passing terminal outcomes', () => {
    const markup = renderToStaticMarkup(
      <CIStatusBadge
        checks={[
          createCheck('lint', 'SKIPPED'),
          createCheck('build', 'CANCELLED'),
          createCheck('audit', 'NEUTRAL'),
        ]}
      />
    );

    expect(markup).toContain('3 skipped');
    expect(markup).not.toContain('0 passed');
  });
});
