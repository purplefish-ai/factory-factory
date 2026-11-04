import { describe, expect, expectTypeOf, it } from 'vitest';
import { WORKSPACE_SIDEBAR_CI_STATES } from '@/shared/core';
import {
  WORKSPACE_STATUS_REASON_TONES,
  type WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';
import {
  DIFF_STAT_CLASS_NAMES,
  getCiStateTone,
  getPrStatePresentation,
  getStatusToneStyle,
  STATUS_TONES,
  type StatusTone,
} from './status-tones';

const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:red|green|amber|yellow|orange|emerald|blue|sky|violet|purple|zinc|slate|gray)-\d/;

describe('status tones', () => {
  it('covers every workspace status reason tone', () => {
    expectTypeOf<WorkspaceStatusReasonTone>().toExtend<StatusTone>();
    for (const tone of WORKSPACE_STATUS_REASON_TONES) {
      expect(STATUS_TONES).toContain(tone);
    }
  });

  it.each(STATUS_TONES)('styles %s with its theme token only', (tone) => {
    const style = getStatusToneStyle(tone);
    const classes = [style.text, style.dot, style.chip, style.surface, style.border].join(' ');
    expect(classes).not.toMatch(RAW_PALETTE_CLASS);
    expect(style.text).toBe(`text-${style.token}`);
    expect(style.chip).toContain(`text-${style.token}`);
    expect(style.surface).toContain(`text-${style.token}`);
  });

  it('uses the brand-backed running token for live work and animates only it', () => {
    expect(getStatusToneStyle('working')).toMatchObject({ token: 'running', pulse: true });
    expect(STATUS_TONES.filter((tone) => getStatusToneStyle(tone).pulse)).toEqual(['working']);
  });

  it('keeps running, waiting, attention, danger and success visually distinct', () => {
    const tokens = (['working', 'waiting', 'attention', 'danger', 'success'] as const).map(
      (tone) => getStatusToneStyle(tone).token
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('shares the warning token between attention and warning messages', () => {
    expect(getStatusToneStyle('attention').token).toBe('warning');
    expect(getStatusToneStyle('attention').icon).not.toBe(getStatusToneStyle('warning').icon);
  });

  it('maps diff statistics to the success and danger tokens', () => {
    expect(DIFF_STAT_CLASS_NAMES).toEqual({
      added: 'text-success',
      removed: 'text-destructive',
    });
  });
});

describe('getPrStatePresentation', () => {
  it.each([
    ['DRAFT', 'neutral', 'Draft'],
    ['OPEN', 'success', 'Open'],
    ['APPROVED', 'success', 'Approved'],
    ['CHANGES_REQUESTED', 'danger', 'Changes requested'],
    ['MERGED', 'merged', 'Merged'],
    ['CLOSED', 'danger', 'Closed'],
  ] as const)('presents %s as %s', (state, tone, label) => {
    expect(getPrStatePresentation(state)).toEqual({ tone, label });
  });

  it('returns null without a pull request', () => {
    expect(getPrStatePresentation('NONE')).toBeNull();
    expect(getPrStatePresentation(null)).toBeNull();
    expect(getPrStatePresentation(undefined)).toBeNull();
  });

  it('gives draft, open, merged and closed distinct looks', () => {
    const tones = (['DRAFT', 'OPEN', 'MERGED', 'CLOSED'] as const).map(
      (state) => getPrStatePresentation(state)?.tone
    );
    expect(new Set(tones).size).toBe(4);
  });
});

describe('getCiStateTone', () => {
  it('maps every sidebar CI state', () => {
    expect(
      Object.fromEntries(WORKSPACE_SIDEBAR_CI_STATES.map((state) => [state, getCiStateTone(state)]))
    ).toEqual({
      NONE: 'neutral',
      RUNNING: 'waiting',
      FAILING: 'danger',
      PASSING: 'success',
      UNKNOWN: 'neutral',
      CLOSED: 'danger',
      MERGED: 'merged',
      CONFLICT: 'attention',
    });
  });
});
