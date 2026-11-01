import { expect, it } from 'vitest';
import type { SubagentSummary } from '@/shared/acp-protocol';
import { getSubagentIconIndices } from './subagent-icon-indices';

it('orders known timestamps before unknown times, breaks ties by ID and deduplicates pages', () => {
  const agents = [
    { id: 'unknown', createdAt: null },
    { id: 'b', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'a', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'a', createdAt: '2026-10-30T12:00:00Z' },
    { id: 'invalid', createdAt: 'invalid' },
  ];
  expect([
    ...getSubagentIconIndices(
      agents.map((agent) => ({ ...agent, status: 'running', completedAt: null, updatedAt: null }))
    ),
  ]).toEqual([
    ['a', 0],
    ['b', 1],
    ['invalid', 2],
    ['unknown', 3],
  ]);
  expect(agents[0]?.id).toBe('unknown');
});

function agent(
  id: string,
  createdAt: string | null,
  status: SubagentSummary['status'] = 'running',
  completedAt: string | null = null,
  updatedAt: string | null = completedAt
) {
  return { id, createdAt, status, completedAt, updatedAt };
}

it('reuses a released icon without changing assignments of overlapping agents', () => {
  const agents = [
    agent('a', '2026-10-30T12:00:00Z', 'completed', '2026-10-30T12:02:00Z'),
    agent('b', '2026-10-30T12:01:00Z'),
    agent('c', '2026-10-30T12:02:00Z'),
  ];
  expect([...getSubagentIconIndices(agents)]).toEqual([
    ['a', 0],
    ['b', 1],
    ['c', 0],
  ]);
  expect([...getSubagentIconIndices([...agents].reverse())]).toEqual([
    ['a', 0],
    ['b', 1],
    ['c', 0],
  ]);
});

it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
  'releases icons for %s agents using updatedAt when completedAt is absent',
  (status) => {
    expect([
      ...getSubagentIconIndices([
        agent('a', '2026-10-30T12:00:00Z', status, null, '2026-10-30T12:01:00Z'),
        agent('b', '2026-10-30T12:02:00Z'),
      ]),
    ]).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  }
);

it.each(['starting', 'running', 'waiting'] as const)('keeps %s agents claims', (status) => {
  expect([
    ...getSubagentIconIndices([
      agent('a', '2026-10-30T12:00:00Z', status, '2026-10-30T12:01:00Z'),
      agent('b', '2026-10-30T12:02:00Z'),
    ]),
  ]).toEqual([
    ['a', 0],
    ['b', 1],
  ]);
});

it('does not infer releases from unknown or invalid lifecycle times', () => {
  expect([
    ...getSubagentIconIndices([
      agent('a', '2026-10-30T12:00:00Z', 'completed'),
      agent('b', '2026-10-30T12:01:00Z', 'failed', 'invalid'),
      agent('c', '2026-10-30T12:02:00Z', 'completed', '2026-10-30T12:03:00Z'),
      agent('d', null),
      agent('e', 'invalid'),
    ]),
  ]).toEqual([
    ['a', 0],
    ['b', 1],
    ['c', 2],
    ['d', 3],
    ['e', 4],
  ]);
});

it('reuses icons across more than twelve sequential agents', () => {
  const agents = Array.from({ length: 15 }, (_, index) =>
    agent(
      String(index),
      new Date(index * 2000).toISOString(),
      'completed',
      new Date(index * 2000 + 1000).toISOString()
    )
  );
  expect([...getSubagentIconIndices(agents).values()]).toEqual(Array(15).fill(0));
});
