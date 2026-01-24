/**
 * Handle task.top_level.created event
 *
 * In the reconciliation pattern, event handlers are simple:
 * they just update state and trigger reconciliation.
 *
 * The reconciler is responsible for:
 * - Creating the supervisor agent
 * - Setting up worktree and branch
 * - Managing agent lifecycle
 */

import { TaskState } from '@prisma-gen/client';
import { taskAccessor } from '../../resource_accessors/index.js';
import { inngest } from '../client.js';
import { triggerTaskReconciliation } from './reconciliation.js';

export const topLevelTaskCreatedHandler = inngest.createFunction(
  {
    id: 'top-level-task-created',
    name: 'Handle Top-Level Task Created',
    retries: 3,
  },
  { event: 'task.top_level.created' },
  async ({ event, step }) => {
    const { taskId } = event.data;

    console.log(`Top-level task created event received for task ${taskId}`);

    // Step 1: Verify task exists and set state to PLANNING
    const topLevelTask = await step.run('set-planning-state', async () => {
      const task = await taskAccessor.findById(taskId);
      if (!task) {
        throw new Error(`Task with ID '${taskId}' not found`);
      }
      if (task.parentId !== null) {
        throw new Error(
          `Task '${taskId}' is not a top-level task (has parentId: ${task.parentId})`
        );
      }

      // Ensure task is in PLANNING state (may already be from creation)
      if (task.state !== TaskState.PLANNING) {
        await taskAccessor.update(taskId, { state: TaskState.PLANNING });
      }

      return {
        id: task.id,
        title: task.title,
        state: TaskState.PLANNING,
      };
    });

    // Step 2: Trigger reconciliation to create supervisor and infrastructure
    await step.run('trigger-reconciliation', async () => {
      await triggerTaskReconciliation(taskId);
    });

    console.log(`Reconciliation triggered for top-level task ${taskId}`);

    return {
      success: true,
      taskId,
      taskTitle: topLevelTask.title,
      state: topLevelTask.state,
      message: `Task state set to PLANNING, reconciliation triggered`,
    };
  }
);
