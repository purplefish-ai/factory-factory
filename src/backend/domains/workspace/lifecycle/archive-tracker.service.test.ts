import { beforeEach, describe, expect, it } from 'vitest';
import { workspaceArchiveTrackerService } from './archive-tracker.service';

describe('WorkspaceArchiveTrackerService', () => {
  beforeEach(() => {
    workspaceArchiveTrackerService.reset();
  });

  it('tracks workspace IDs marked as archiving', () => {
    workspaceArchiveTrackerService.markArchiving('ws-1');

    expect(workspaceArchiveTrackerService.isArchiving('ws-1')).toBe(true);
  });

  it('clears workspace IDs from archiving set', () => {
    workspaceArchiveTrackerService.markArchiving('ws-1');
    workspaceArchiveTrackerService.clearArchiving('ws-1');

    expect(workspaceArchiveTrackerService.isArchiving('ws-1')).toBe(false);
  });
});
