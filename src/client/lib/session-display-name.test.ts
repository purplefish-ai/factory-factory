import { describe, expect, it } from 'vitest';
import { getSessionDisplayName } from './session-display-name';

describe('session display names', () => {
  it.each([
    ['Periodic task', 'periodic-task', 'Agent'],
    ['Agent', 'periodic-task', 'Agent'],
    ['Periodic task review', 'periodic-task', 'Periodic task review'],
    ['Custom name', 'periodic-task', 'Custom name'],
    ['Periodic task', null, 'Periodic task'],
    ['Periodic task', undefined, 'Periodic task'],
    ['Periodic task', 'followup', 'Periodic task'],
    [null, 'periodic-task', 'Chat 3'],
    [undefined, undefined, 'Chat 3'],
  ])('displays %s with workflow %s as %s', (name, workflow, expected) => {
    expect(getSessionDisplayName({ name, workflow }, 'Chat 3')).toBe(expected);
  });
});
