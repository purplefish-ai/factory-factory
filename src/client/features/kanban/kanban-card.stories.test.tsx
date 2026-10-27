// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  AutoIterationCompleted,
  AutoIterationPaused,
  AutoIterationRunning,
  AutoIterationUnknown,
} from '@/client/features/kanban/kanban-card.stories';
import { WorkspaceSummarySchema, serializeWorkspaceSummary } from '@/shared/workspace-summary';

describe('auto-iteration card story contracts', () => {
  it.each([
    AutoIterationRunning,
    AutoIterationPaused,
    AutoIterationCompleted,
    AutoIterationUnknown,
  ])('supplies a canonical summary without raw loop payloads', (story) => {
    const workspace = story.args?.workspace;
    if (!workspace) {
      throw new Error('Expected the story workspace');
    }
    expect(WorkspaceSummarySchema.safeParse(serializeWorkspaceSummary(workspace)).success).toBe(
      true
    );
    expect(workspace.autoIteration?.status).toBe(workspace.autoIterationStatus);
    expect(workspace).not.toHaveProperty('autoIterationConfig');
    expect(workspace).not.toHaveProperty('autoIterationProgress');
  });
});
