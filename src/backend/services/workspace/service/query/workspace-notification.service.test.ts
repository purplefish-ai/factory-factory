import type { WorkspaceNotification } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceNotificationAccessor } from '@/backend/services/workspace/resources/workspace-notification.accessor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceNotificationService } from './workspace-notification.service';

vi.mock('@/backend/services/workspace/resources/workspace-notification.accessor', () => ({
  workspaceNotificationAccessor: {
    findPending: vi.fn(),
  },
}));

describe('workspaceNotificationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pending notifications oldest-first for deterministic delivery', async () => {
    const newer = unsafeCoerce<WorkspaceNotification>({
      id: 'newer',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const older = unsafeCoerce<WorkspaceNotification>({
      id: 'older',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    vi.mocked(workspaceNotificationAccessor.findPending).mockResolvedValue([newer, older]);

    await expect(workspaceNotificationService.listPendingForDelivery('ws-1')).resolves.toEqual([
      older,
      newer,
    ]);
  });
});
