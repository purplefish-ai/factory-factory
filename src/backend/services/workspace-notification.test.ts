/**
 * Tests for workspace notification trigger on kanban state transitions.
 * Validates that notifications only fire when workspace transitions to WAITING column.
 */

import { KanbanColumn, PRState, WorkspaceStatus } from '@prisma-gen/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { kanbanStateService } from './kanban-state.service';
import { sessionService } from './session.service';

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

    // Mock session service to return false (session not working anymore)
    vi.spyOn(sessionService, 'isAnySessionWorking').mockReturnValue(false);

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

  it('does not emit event when workspace stays in same column and wasWorking=false', async () => {
    // Workspace already in WAITING
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WAITING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    // Mock session service - not working and column not changing means no event
    vi.spyOn(sessionService, 'isAnySessionWorking').mockReturnValue(false);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No event should be emitted if column didn't change and wasWorking=false
    expect(eventEmitted).toBe(false);
  });

  it('emits event when workspace stays in WAITING but session just completed (wasWorking=true)', async () => {
    // Workspace already in WAITING column (no column change)
    mockWorkspace.cachedKanbanColumn = KanbanColumn.WAITING;

    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue({
      ...mockWorkspace,
      terminalSessions: [],
    } as never);
    vi.spyOn(workspaceAccessor, 'update').mockResolvedValue({} as never);

    let eventEmitted = false;
    let eventData: unknown = null;
    kanbanStateService.once('transition_to_waiting', (data) => {
      eventEmitted = true;
      eventData = data;
    });

    // Pass wasWorkingBeforeUpdate=true to simulate session just completed
    // This is what happens from result handler in chat-event-forwarder
    await kanbanStateService.updateCachedKanbanColumn('workspace-1', true);

    // Event should be emitted because wasWorking=true (session completed)
    expect(eventEmitted).toBe(true);
    expect(eventData).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceName: 'Test Workspace',
      sessionCount: 1,
    });
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

    // Mock session service
    vi.spyOn(sessionService, 'isAnySessionWorking').mockReturnValue(false);

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

    // Mock session service
    vi.spyOn(sessionService, 'isAnySessionWorking').mockReturnValue(false);

    let eventEmitted = false;
    kanbanStateService.once('transition_to_waiting', () => {
      eventEmitted = true;
    });

    await kanbanStateService.updateCachedKanbanColumn('workspace-1');

    // No transition to WAITING because ratchet is fixing
    expect(eventEmitted).toBe(false);
  });
});
