import { expect, it } from 'vitest';
import { getLiveSessionControlId } from './live-session-control';

it('exposes a control session only while connected to an installed ready runtime', () => {
  expect(getLiveSessionControlId('parent', true, { phase: 'running', processState: 'alive' })).toBe(
    'parent'
  );
  expect(getLiveSessionControlId('parent', true, { phase: 'idle', processState: 'alive' })).toBe(
    'parent'
  );
  expect(
    getLiveSessionControlId('parent', false, { phase: 'running', processState: 'alive' })
  ).toBeUndefined();
  for (const phase of ['loading', 'starting', 'stopping', 'error'] as const) {
    expect(
      getLiveSessionControlId('parent', true, { phase, processState: 'alive' })
    ).toBeUndefined();
  }
  expect(
    getLiveSessionControlId('parent', true, { phase: 'idle', processState: 'stopped' })
  ).toBeUndefined();
  expect(
    getLiveSessionControlId('parent', true, { phase: 'idle', processState: 'unknown' })
  ).toBeUndefined();
  expect(
    getLiveSessionControlId(null, true, { phase: 'idle', processState: 'alive' })
  ).toBeUndefined();
});
