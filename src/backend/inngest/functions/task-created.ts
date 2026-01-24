/**
 * Handle task.created event (for subtasks/leaf tasks)
 *
 * In the reconciliation pattern, event handlers are simple:
 * they just verify state and trigger reconciliation.
 *
 * The reconciler is responsible for:
 * - Checking if task is blocked
 * - Creating the worker agent
 * - Setting up worktree and branch
 * - Managing agent lifecycle
 */

import { taskAccessor } from '../../resource_accessors/index.js';
import { inngest } from '../client.js';
import { triggerTaskReconciliation } from './reconciliation.js';

export const taskCreatedHandler = inngest.createFunction(
  {
    id: 'task-created',
    name: 'Handle Task Created',
    retries: 3,
  },
  { event: 'task.created' },
  async ({ event, step }) => {
    const { taskId, parentId } = event.data;

    console.log(`Task created event received for task ${taskId} (parent: ${parentId})`);

    // Step 1: Verify task exists
    const task = await step.run('verify-task', async () => {
      const task = await taskAccessor.findById(taskId);
      if (!task) {
        throw new Error(`Task with ID '${taskId}' not found`);
      }
      return {
        id: task.id,
        title: task.title,
        parentId: task.parentId,
        state: task.state,
      };
    });

    // Step 2: Trigger reconciliation to handle worker creation and infrastructure
    await step.run('trigger-reconciliation', async () => {
      await triggerTaskReconciliation(taskId);
    });

    console.log(`Reconciliation triggered for task ${taskId}`);

    return {
      success: true,
      taskId,
      taskTitle: task.title,
      parentId: task.parentId,
      state: task.state,
      message: `Reconciliation triggered for task`,
    };
  }
);
