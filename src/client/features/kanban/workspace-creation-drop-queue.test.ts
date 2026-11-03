import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  getPendingWorkspaceCreationDropProjectIds,
  getWorkspaceCreationDropGeneration,
  resetWorkspaceCreationDrops,
  stageWorkspaceCreationAttachments,
  subscribeWorkspaceCreationDrops,
  takeWorkspaceCreationAttachments,
} from './workspace-creation-drop-queue';

function attachment(name: string): MessageAttachment {
  return { id: name, name, type: 'image/png', size: 1, data: 'aQ==', contentType: 'image' };
}

describe('workspace creation drop queue', () => {
  it('queues attachments per project until they are taken once', () => {
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceCreationDrops(listener);
    try {
      stageWorkspaceCreationAttachments(projectId, 0, [attachment('first.png')]);
      stageWorkspaceCreationAttachments(projectId, 0, [attachment('second.png')]);
      stageWorkspaceCreationAttachments(otherProjectId, 0, [attachment('other.png')]);
      expect(listener).toHaveBeenCalledTimes(3);
      const pending = getPendingWorkspaceCreationDropProjectIds();
      expect(pending).toEqual(expect.arrayContaining([projectId, otherProjectId]));
      expect(getPendingWorkspaceCreationDropProjectIds()).toBe(pending);

      expect(takeWorkspaceCreationAttachments(projectId).map(({ name }) => name)).toEqual([
        'first.png',
        'second.png',
      ]);
      expect(takeWorkspaceCreationAttachments(projectId)).toEqual([]);
      expect(getPendingWorkspaceCreationDropProjectIds()).not.toContain(projectId);
      expect(getPendingWorkspaceCreationDropProjectIds()).toContain(otherProjectId);
    } finally {
      unsubscribe();
      takeWorkspaceCreationAttachments(otherProjectId);
    }
  });

  it('drops queued attachments and reads started before the draft was cleared', () => {
    const projectId = crypto.randomUUID();
    stageWorkspaceCreationAttachments(projectId, 0, [attachment('queued.png')]);
    resetWorkspaceCreationDrops(projectId);
    expect(getWorkspaceCreationDropGeneration(projectId)).toBe(1);
    expect(getPendingWorkspaceCreationDropProjectIds()).not.toContain(projectId);

    stageWorkspaceCreationAttachments(projectId, 0, [attachment('late.png')]);
    expect(takeWorkspaceCreationAttachments(projectId)).toEqual([]);

    stageWorkspaceCreationAttachments(projectId, 1, [attachment('current.png')]);
    expect(takeWorkspaceCreationAttachments(projectId).map(({ name }) => name)).toEqual([
      'current.png',
    ]);
  });

  it('ignores empty batches without notifying subscribers', () => {
    const projectId = crypto.randomUUID();
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceCreationDrops(listener);
    stageWorkspaceCreationAttachments(projectId, 0, []);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(getPendingWorkspaceCreationDropProjectIds()).not.toContain(projectId);
  });
});
