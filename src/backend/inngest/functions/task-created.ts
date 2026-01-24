import { startWorker } from '../../agents/worker/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { inngest } from '../client.js';

/**
 * Handle task.created event by starting a worker agent
 *
 * This handler is triggered when a supervisor creates a subtask under a top-level task.
 * It automatically creates and starts a worker agent to implement the task.
 */
export const taskCreatedHandler = inngest.createFunction(
  {
    id: 'task-created',
    name: 'Handle Task Created',
    retries: 3,
  },
  { event: 'task.created' },
  async ({ event, step }) => {
    const { taskId, parentId, title } = event.data;

    console.log(`Task created event received for task ${taskId} (parent: ${parentId})`);

    // Step 1: Verify task exists and get its details
    const task = await step.run('verify-task', async () => {
      const task = await taskAccessor.findById(taskId);
      if (!task) {
        throw new Error(`Task with ID '${taskId}' not found`);
      }
      return {
        id: task.id,
        title: task.title,
        parentId: task.parentId,
      };
    });

    // Step 2: Check if task is blocked by dependencies
    const isBlocked = await step.run('check-dependencies', () => {
      return taskAccessor.isBlocked(taskId);
    });

    if (isBlocked) {
      console.log(`Task ${taskId} is blocked by dependencies, skipping worker creation`);
      return {
        success: true,
        taskId,
        taskTitle: task.title,
        parentId: task.parentId,
        agentId: null,
        message: `Task ${taskId} is blocked by dependencies, worker will be created when unblocked`,
        blocked: true,
      };
    }

    // Step 3: Start worker for the task
    const workerResult = await step.run('start-worker', async () => {
      try {
        const agentId = await startWorker(taskId);
        console.log(`Started worker ${agentId} for task ${taskId}`);

        // Log the worker creation
        await decisionLogAccessor.createManual(
          agentId,
          `Worker created for task "${title}"`,
          `Automatic worker creation triggered by task.created event`,
          JSON.stringify({ taskId, parentId, title })
        );

        return {
          success: true,
          agentId,
          message: `Worker ${agentId} started for task ${taskId}`,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start worker for task ${taskId}:`, error);

        // Try to find the top-level task to get the supervisor
        const topLevelTask = await taskAccessor.getTopLevelParent(taskId);
        const supervisor = topLevelTask
          ? await agentAccessor.findSupervisorByTopLevelTaskId(topLevelTask.id)
          : null;

        if (supervisor) {
          // Notify supervisor about the failure
          await mailAccessor.create({
            toAgentId: supervisor.id,
            subject: `Failed to create worker for task: ${title}`,
            body:
              `The system failed to automatically create a worker for task "${title}".\n\n` +
              `Task ID: ${taskId}\n` +
              `Error: ${errorMessage}\n\n` +
              `You may need to manually retry or investigate.`,
          });
        }

        // Also notify human
        await mailAccessor.create({
          isForHuman: true,
          subject: `Failed to create worker for task: ${title}`,
          body:
            `The system failed to automatically create a worker for task "${title}".\n\n` +
            `Task ID: ${taskId}\n` +
            `Parent ID: ${parentId}\n` +
            `Error: ${errorMessage}\n\n` +
            `Manual intervention may be required.`,
        });

        throw error;
      }
    });

    return {
      success: workerResult.success,
      taskId,
      taskTitle: task.title,
      parentId: task.parentId,
      agentId: workerResult.agentId,
      message: workerResult.message,
      blocked: false,
    };
  }
);
