import { describe, expect, it } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import {
  deserializeWorkspaceSummary,
  serializeWorkspaceSummary,
  WorkspaceSummarySchema,
} from '@/shared/workspace-summary';

describe('optimistic workspace summary', () => {
  it('creates a complete setting-up list row', () => {
    const createdAt = new Date('2026-10-27T12:00:00.000Z');
    const row = createOptimisticWorkspaceSummary({
      id: 'new',
      projectId: 'project',
      name: 'Workspace',
      ratchetEnabled: false,
      createdAt,
    });
    expect(row).toMatchObject({
      id: 'new',
      projectId: 'project',
      name: 'Workspace',
      status: 'NEW',
      createdAt,
      prs: [],
      prState: 'NONE',
      prCiStatus: 'UNKNOWN',
      ratchetEnabled: false,
      prMonitoring: { enabled: false, deliveryMode: 'MAIN', pendingEventCount: 0 },
      isWorking: true,
      kanbanColumn: 'WORKING',
      sidebarStatus: { activityState: 'WORKING', ciState: 'NONE' },
      statusReason: {
        code: 'SETTING_UP',
        label: 'Setting up workspace',
        tone: 'working',
        needsUser: false,
      },
      gitStats: null,
      lastActivityAt: null,
      sessionSummaries: [],
    });
    expect(WorkspaceSummarySchema.safeParse(serializeWorkspaceSummary(row)).success).toBe(true);
  });

  it('adapts createdAt explicitly while retaining other timestamp representations', () => {
    const row = {
      ...createOptimisticWorkspaceSummary({
        id: 'new',
        projectId: 'project',
        name: 'Workspace',
        ratchetEnabled: true,
        createdAt: new Date('2026-10-27T12:00:00.000Z'),
      }),
      lastActivityAt: '2026-10-27T13:00:00Z',
    };
    const serialized = serializeWorkspaceSummary(row);
    expect(serialized.createdAt).toBe('2026-10-27T12:00:00.000Z');
    expect(serialized.lastActivityAt).toBe('2026-10-27T13:00:00Z');
    const restored = deserializeWorkspaceSummary(serialized);
    expect(restored.createdAt).toEqual(row.createdAt);
    expect(restored.lastActivityAt).toBe(row.lastActivityAt);
  });
});
