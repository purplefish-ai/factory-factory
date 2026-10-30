import { expect, it } from 'vitest';
import { getSubagentIconIndices } from './subagent-icon-indices';

it('orders known timestamps before unknown times, breaks ties by ID and deduplicates pages', () => {
  const agents = [
    { id: 'unknown', createdAt: null },
    { id: 'b', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'a', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'a', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'invalid', createdAt: 'invalid' },
  ];
  expect([...getSubagentIconIndices(agents)]).toEqual([
    ['a', 0],
    ['b', 1],
    ['invalid', 2],
    ['unknown', 3],
  ]);
  expect(agents[0]?.id).toBe('unknown');
});
