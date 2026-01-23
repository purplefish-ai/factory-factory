import { inngest } from '../client.js';
import { startWorker } from '../../agents/worker/lifecycle.js';
import { decisionLogAccessor, taskAccessor, mailAccessor, agentAccessor } from '../../resource_accessors/index.js';

/**
 * Handle task.created event by starting a worker agent
 *
 * This handler is triggered when a supervisor creates a task for an epic.
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
    const { taskId, epicId, title } = event.data;

    console.log(`Task created event received for task ${taskId} (epic: ${epicId})`);

    // Step 1: Verify task exists
    const task = await step.run('verify-task', async () => {
      const task = await taskAccessor.findById(taskId);
      if (!task) {
        throw new Error(`Task with ID '${taskId}' not found`);
      }
      return {
        id: task.id,
        title: task.title,
        epicId: task.epicId,
      };
    });

    // Step 2: Start worker for the task
    const workerResult = await step.run('start-worker', async () => {
      try {
        const agentId = await startWorker(taskId);
        console.log(`Started worker ${agentId} for task ${taskId}`);

        // Log the worker creation
        await decisionLogAccessor.createManual(
          agentId,
          `Worker created for task "${title}"`,
          `Automatic worker creation triggered by task.created event`,
          JSON.stringify({ taskId, epicId, title })
        );

        return {
          success: true,
          agentId,
          message: `Worker ${agentId} started for task ${taskId}`,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start worker for task ${taskId}:`, error);

        // Try to find the supervisor for this epic to notify them
        const supervisor = await agentAccessor.findByEpicId(epicId);

        if (supervisor) {
          // Notify supervisor about the failure
          await mailAccessor.create({
            toAgentId: supervisor.id,
            subject: `Failed to create worker for task: ${title}`,
            body: `The system failed to automatically create a worker for task "${title}".\n\n` +
              `Task ID: ${taskId}\n` +
              `Error: ${errorMessage}\n\n` +
              `You may need to manually retry or investigate.`,
          });
        }

        // Also notify human
        await mailAccessor.create({
          isForHuman: true,
          subject: `Failed to create worker for task: ${title}`,
          body: `The system failed to automatically create a worker for task "${title}".\n\n` +
            `Task ID: ${taskId}\n` +
            `Epic ID: ${epicId}\n` +
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
      epicId: task.epicId,
      agentId: workerResult.agentId,
      message: workerResult.message,
    };
  }
);
