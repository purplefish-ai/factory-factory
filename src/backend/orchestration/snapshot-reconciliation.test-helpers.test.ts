import { expect, it } from 'vitest';
import { WorkspaceSnapshotEntrySchema } from '@/shared/workspace-snapshot';
import { createSnapshotEntry } from './snapshot-reconciliation.test-helpers';

it('creates a snapshot fixture accepted by the snapshot wire schema', () => {
  const entry = createSnapshotEntry();
  expect(WorkspaceSnapshotEntrySchema.parse(entry)).toEqual(entry);
});
