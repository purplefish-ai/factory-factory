import { describe, expect, it } from 'vitest';
import {
  createWorkspaceCreationDraft,
  workspaceCreationDraftSchema,
} from './workspace-creation-draft-storage';

describe('versioned creation draft validation', () => {
  it.each([
    { schemaVersion: 2 },
    { attachments: [{ id: 'missing-contents' }] },
    { launchSelection: { provider: 'unknown', drafts: {} } },
  ])('rejects incompatible storage instead of restoring a partial draft: %j', (patch) => {
    expect(
      workspaceCreationDraftSchema.safeParse({ ...createWorkspaceCreationDraft(), ...patch })
        .success
    ).toBe(false);
  });
});
