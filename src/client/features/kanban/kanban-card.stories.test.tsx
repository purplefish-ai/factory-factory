// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  AutoIterationCompleted,
  AutoIterationPaused,
  AutoIterationRunning,
} from '@/client/features/kanban/kanban-card.stories';
import { projectAutoIterationSummary } from '@/shared/workspace-summary';

describe('auto-iteration card story contracts', () => {
  it.each([AutoIterationRunning, AutoIterationPaused, AutoIterationCompleted])(
    'supplies the canonical compact value alongside legacy fields',
    (story) => {
      const workspace = story.args?.workspace;
      if (!workspace) {
        throw new Error('Expected the story workspace');
      }
      expect(workspace.autoIteration).toEqual(projectAutoIterationSummary(workspace));
    }
  );
});
