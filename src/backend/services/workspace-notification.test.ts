/**
 * Tests for workspace notification trigger on kanban state transitions.
 * Validates that notifications only fire when workspace transitions to WAITING column.
 */

import { KanbanColumn, PRState, WorkspaceStatus } from '@prisma-gen/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { kanbanStateService } from './kanban-state.service';
import { workspaceActivityService } from './workspace-activity.service';

describe('Workspace Notification on WAITING Transition', () => {
  let mockWorkspace: {
    id: string;
    name: string;
    status: WorkspaceStatus;
    prState: PRState;
    hasHadSessions: boolean;
    cachedKanbanColumn: KanbanColumn;
    ratchetEnabled: boolean;
    ratchetState: string;
    prCiStatus: string;
    prUrl: string | null;
    prUpdatedAt: Date | null;
    claudeSessions: Array<{ id: string }>;
  };

  beforeEach(() => {
    mockWorkspace = {
      id: 'workspace-1',
      name: 'Test Workspace',
      status: WorkspaceStatus.READY,
      prState: PRState.NONE,
      hasHadSessions: true,
      cachedKanbanColumn: KanbanColumn.WORKING,
      ratchetEnabled: false,
      ratchetState: 'IDLE',
      prCiStatus: 'UNKNOWN',
      prUrl: null,
      prUpdatedAt: null,
      claudeSessions: [{ id: 'session-1' }],
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits transition_to_waiting event when workspace moves from WORKING to WAITING', async () => {
    // Mock the workspace accessor to return workspace in WORKING state
    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock workspace activity service to show no sessions running
    vi.spyOn(workspaceActivityService, 'isWorkspaceActive').mockReturnValue(false);

    // Set up event listener
    let eventEmitted = false;
    let eventData: unknown = null;
    kanbanStateService.once('transition_to_waiting', (data) => {
      eventEmitted = true;
      eventData = data;
    });

    // Update kanban column - workspace is now idle (not working), so should transition to WAITING
    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // Verify event was emitted
    expect(eventEmitted).toBe(true);
    expect(eventData).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceName: 'Test Workspace',
      sessionCount: 1,
    });
  });

  it('does not emit event when workspace stays in WAITING and no column change', async () => {
    // Workspace already in WAITING
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WAITING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock workspace activity - no sessions running
    vi.spyOn(workspaceActivityService, 'isWorkspaceActive').mockReturnValue(false);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No event should be emitted if column didn't change (stays WAITING)
    expect(eventEmitted).toBe(false);
  });

  it('does not emit event when sessions still running even if column is WAITING', async () => {
    // Workspace in WAITING column
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WAITING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock workspace activity - sessions still running (multi-session workspace)
    vi.spyOn(workspaceActivityService, 'isWorkspaceActive').mockReturnValue(true);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No event should be emitted because sessions are still running
    expect(eventEmitted).toBe(false);
  });

  it('does not emit event when transitioning to DONE instead of WAITING', async () => {
    // Workspace with merged PR should go to DONE
    mockWorkspace.prState = PRState.MERGED;
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WORKING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock workspace activity
    vi.spyOn(workspaceActivityService, 'isWorkspaceActive').mockReturnValue(false);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No event for transition to DONE
    expect(eventEmitted).toBe(false);
  });

  it('does not emit event for workspaces with ratchet fixing states (still WORKING)', async () => {
    // Workspace with ratchet enabled and in fixing state should stay WORKING
    mockWorkspace.ratchetEnabled = true;
    mockWorkspace.ratchetState = 'CI_FAILED'; // This keeps it in WORKING
    mockWorkspace.prUrl = 'https://github.com/owner/repo/pull/1';
    mockWorkspace.prState = PRState.OPEN;
    mockWorkspace.prCiStatus = 'FAILURE';
    mockWorkspace.prUpdatedAt = new Date();
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WORKING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock workspace activity
    vi.spyOn(workspaceActivityService, 'isWorkspaceActive').mockReturnValue(false);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No transition to WAITING because ratchet is fixing
    expect(eventEmitted).toBe(false);
  });
});
