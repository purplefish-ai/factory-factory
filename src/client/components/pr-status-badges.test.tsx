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

// Same utilities and palettes as factory/no-raw-palette-classes (lint-rules/factory.mjs).
const RAW_PALETTE_CLASS =
  /(?<=^|[\s'"`:!])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|text-shadow|drop-shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?![\w-])/;

describe('CIChecksSection', () => {
  // Render each check on its own so a tone or label cannot be credited to the
  // wrong check (e.g. swapped skipped and cancelled presentations).
  it.each([
    ['skipped', createCheck('lint', 'SKIPPED'), 'neutral', 'text-muted-foreground', 'Skipped'],
    ['cancelled', createCheck('build', 'CANCELLED'), 'danger', 'text-destructive', 'Cancelled'],
    ['neutral', createCheck('coverage', 'NEUTRAL'), 'success', 'text-success', 'Neutral'],
    ['failed', createCheck('deploy', 'FAILURE'), 'danger', 'text-destructive', 'Failure'],
    [
      'timed out',
      {
        __typename: 'CheckRun' as const,
        name: 'slow',
        status: 'COMPLETED' as const,
        conclusion: 'TIMED_OUT' as const,
      },
      'danger',
      'text-destructive',
      'Timed out',
    ],
    [
      'in progress',
      {
        __typename: 'CheckRun' as const,
        name: 'e2e',
        status: 'IN_PROGRESS' as const,
        conclusion: null,
      },
      'waiting',
      'text-info',
      'Running',
    ],
  ])('renders a %s check with its tone and humanized label', (_, check, tone, textClass, label) => {
    const markup = renderToStaticMarkup(<CIChecksSection checks={[check]} />);
    // A single check renders exactly one status icon.
    expect(markup.match(/data-status-tone=/g)).toHaveLength(1);
    expect(markup.match(/data-status-tone="(\w+)"/)?.[1]).toBe(tone);
    expect(markup).toContain(`class="text-xs ${textClass}">${label}<`);
    expect(markup).not.toContain(check.conclusion ?? check.status);
    expect(markup).not.toMatch(RAW_PALETTE_CLASS);
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
