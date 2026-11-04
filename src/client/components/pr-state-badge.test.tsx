import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CiStatusChip } from './ci-status-chip';
import { PrStateBadge } from './pr-state-badge';

describe('PrStateBadge', () => {
  it('shows only drafts by default', () => {
    expect(renderToStaticMarkup(<PrStateBadge prState="DRAFT" />)).toContain('>Draft<');
    expect(renderToStaticMarkup(<PrStateBadge prState="MERGED" />)).toBe('');
  });

  it.each([
    ['OPEN', 'Open', 'success'],
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
    const markup = renderToStaticMarkup(<CiStatusChip ciState={ciState} showTooltip={false} />);
    expect(markup).toContain(expected);
    expect(markup).not.toMatch(/\b(?:bg|text)-(?:emerald|red|yellow|slate|purple|orange)-\d/);
  });

  it('renders nothing without a PR', () => {
    expect(renderToStaticMarkup(<CiStatusChip ciState="NONE" showTooltip={false} />)).toBe('');
  });
});
