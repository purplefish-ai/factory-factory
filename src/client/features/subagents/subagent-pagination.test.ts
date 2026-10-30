import { describe, expect, it } from 'vitest';
import { getNextSubagentPageParam } from './subagent-pagination';
import type { SubagentListResult } from './types';

describe('getNextSubagentPageParam', () => {
  it.each([
    { nextCursor: 'next', pageParams: [null], expected: 'next' },
    { nextCursor: 'same', pageParams: [null, 'same'], expected: undefined },
    { nextCursor: 'earlier', pageParams: [null, 'earlier', 'latest'], expected: undefined },
    { nextCursor: null, pageParams: [null], expected: undefined },
  ])(
    'returns $expected for cursor $nextCursor after $pageParams',
    ({ nextCursor, pageParams, expected }) => {
      const page: SubagentListResult = { supported: true, subagents: [], nextCursor };
      expect(getNextSubagentPageParam(page, [page], pageParams.at(-1), pageParams)).toBe(expected);
    }
  );

  it('stops for unsupported providers', () => {
    const page: SubagentListResult = { supported: false };
    expect(getNextSubagentPageParam(page, [page], null, [null])).toBeUndefined();
  });
});
