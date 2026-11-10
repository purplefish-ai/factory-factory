import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CiStatusChip } from './ci-status-chip';
import { PrStateBadge } from './pr-state-badge';

// Fixed Tailwind palette utilities, which bypass the theme's status tokens.
const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke|outline|decoration|divide|from|via|to)-(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d|(?:white|black)\b)/;

describe('PrStateBadge', () => {
  it('shows only drafts by default', () => {
    expect(renderToStaticMarkup(<PrStateBadge prState="DRAFT" />)).toContain('>Draft<');
  });

  it.each(['OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'MERGED', 'CLOSED'] as const)(
    'hides %s by default',
    (state) => {
      expect(renderToStaticMarkup(<PrStateBadge prState={state} />)).toBe('');
    }
  );

  it.each([
    ['OPEN', 'Open', 'success'],
    ['APPROVED', 'Approved', 'success'],
    ['CHANGES_REQUESTED', 'Changes requested', 'danger'],
    ['DRAFT', 'Draft', 'neutral'],
    ['MERGED', 'Merged', 'merged'],
    ['CLOSED', 'Closed', 'danger'],
  ] as const)('shows %s with its own look when all states are requested', (state, label, tone) => {
    const markup = renderToStaticMarkup(<PrStateBadge prState={state} showAllStates />);
    expect(markup).toContain(`>${label}<`);
    expect(markup).toContain(`data-status-tone="${tone}"`);
  });

  it('renders nothing without a pull request', () => {
    expect(renderToStaticMarkup(<PrStateBadge prState="NONE" showAllStates />)).toBe('');
    expect(renderToStaticMarkup(<PrStateBadge prState={null} showAllStates />)).toBe('');
  });
});

describe('CiStatusChip', () => {
  it.each([
    ['PASSING', 'bg-success/10'],
    ['FAILING', 'bg-destructive/10'],
    ['RUNNING', 'bg-info/10'],
    ['MERGED', 'bg-merged/10'],
    ['CLOSED', 'bg-destructive/10'],
    ['CONFLICT', 'bg-warning/10'],
    ['UNKNOWN', 'bg-muted'],
  ] as const)('uses theme tokens for %s', (ciState, expected) => {
    const markup = renderToStaticMarkup(<CiStatusChip ciState={ciState} />);
    expect(markup).toContain(expected);
    expect(markup).not.toMatch(RAW_PALETTE_CLASS);
  });

  it('renders nothing without a PR', () => {
    expect(renderToStaticMarkup(<CiStatusChip ciState="NONE" />)).toBe('');
  });
});
