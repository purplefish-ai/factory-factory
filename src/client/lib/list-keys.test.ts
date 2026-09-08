import { describe, expect, it } from 'vitest';
import { withOccurrenceKeys } from './list-keys';

describe('withOccurrenceKeys', () => {
  it('keeps keys attached to identities across insertion and reordering', () => {
    const before = withOccurrenceKeys(['alpha', 'beta'], (item) => item);
    const after = withOccurrenceKeys(['new', 'beta', 'alpha'], (item) => item);

    expect(after[1]?.key).toBe(before[1]?.key);
    expect(after[2]?.key).toBe(before[0]?.key);
    expect(after.map(({ item }) => item)).toEqual(['new', 'beta', 'alpha']);
  });

  it('distinguishes duplicate identities without colliding with identity suffixes', () => {
    const items = ['same', 'same', 'same-1', '["same",1]', ''];
    const keyed = withOccurrenceKeys(items, (item) => item);

    expect(new Set(keyed.map(({ key }) => key)).size).toBe(items.length);
    expect(withOccurrenceKeys(items, (item) => item)).toEqual(keyed);
  });

  it('preserves keys when non-identity fields change', () => {
    const before = withOccurrenceKeys([{ content: 'task', status: 'pending' }], (t) => t.content);
    const after = withOccurrenceKeys([{ content: 'task', status: 'completed' }], (t) => t.content);

    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.item.status).toBe('completed');
    expect(withOccurrenceKeys([], String)).toEqual([]);
  });
});
