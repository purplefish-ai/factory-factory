import { describe, expect, it } from 'vitest';
import {
  createWorkspaceCreationDraft,
  discardWorkspaceCreationDraft,
  workspaceCreationDraftSchema,
} from './workspace-creation-draft-storage';
import {
  getWorkspaceCreationDropGeneration,
  stageWorkspaceCreationAttachments,
  takeWorkspaceCreationAttachments,
} from './workspace-creation-drop-queue';

describe('versioned creation draft validation', () => {
  it('treats older saved ratchet values as initialized choices', () => {
    const restored = workspaceCreationDraftSchema.parse({
      ...createWorkspaceCreationDraft(),
      ratchetEnabled: false,
      ratchetInitialized: undefined,
    });
    expect(restored.ratchetInitialized).toBe(true);
    expect(restored.ratchetEnabled).toBe(false);
  });
  it.each([
    { schemaVersion: 2 },
    { attachments: [{ id: 'missing-contents', name: 'notes.txt', type: 'text/plain', size: 1 }] },
    { launchSelection: { provider: 'unknown', drafts: {} } },
  ])('rejects incompatible storage instead of restoring a partial draft: %j', (patch) => {
    expect(
      workspaceCreationDraftSchema.safeParse({ ...createWorkspaceCreationDraft(), ...patch })
        .success
    ).toBe(false);
  });
});

describe('queued image drops', () => {
  it('drops queued and in-flight images when the draft generation changes', async () => {
    const projectId = crypto.randomUUID();
    const queued = {
      id: 'queued',
      name: 'queued.png',
      type: 'image/png',
      size: 1,
      data: 'aQ==',
      contentType: 'image' as const,
    };
    stageWorkspaceCreationAttachments(projectId, 0, [queued]);

    // A fresh form without a saved draft bumps its generation synchronously.
    await expect(discardWorkspaceCreationDraft(projectId)).resolves.toBe(false);

    expect(getWorkspaceCreationDropGeneration(projectId)).toBe(1);
    expect(takeWorkspaceCreationAttachments(projectId)).toEqual([]);
    stageWorkspaceCreationAttachments(projectId, 0, [queued]);
    expect(takeWorkspaceCreationAttachments(projectId)).toEqual([]);
  });
});
