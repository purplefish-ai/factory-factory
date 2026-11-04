import { expect, it } from 'vitest';
import {
  getAdjacentWorkspaceId,
  getNextWorkspaceNeedingInput,
} from './workspace-shortcut-navigation';
it('steps and wraps workspaces without redirecting a single-item list to itself', () => {
  expect(getAdjacentWorkspaceId(['a', 'b'], 'b', 1)).toBe('a');
  expect(getAdjacentWorkspaceId(['a', 'b'], undefined, -1)).toBe('b');
  expect(getAdjacentWorkspaceId(['a'], 'a', 1)).toBeNull();
  expect(getAdjacentWorkspaceId([], undefined, 1)).toBeNull();
});
it('finds the next blocking request or unread workspace and excludes the current one', () => {
  const items = [
    { id: 'a', pendingRequestType: null },
    { id: 'b', pendingRequestType: 'permission_request' as const },
    { id: 'c', pendingRequestType: null },
  ];
  expect(getNextWorkspaceNeedingInput(items, 'a', () => false)).toBe('b');
  expect(getNextWorkspaceNeedingInput(items, 'b', (id) => id === 'c')).toBe('c');
  expect(getNextWorkspaceNeedingInput(items, 'b', () => false)).toBeNull();
});
