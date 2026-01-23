import { inngest } from '../client.js';
import { startWorker } from '../../agents/worker/lifecycle.js';

/**
 * Handle task.created event by starting a worker agent
 */
export const taskCreatedHandler = inngest.createFunction(
  {
    id: 'task-created',
    name: 'Handle Task Created',
  },
  { event: 'task.created' },
  async ({ event, step }) => {
    const { taskId, epicId } = event.data;

    console.log(`Task created event received for task ${taskId} (epic: ${epicId})`);

    // Start worker for the task
    const agentId = await step.run('start-worker', async () => {
      try {
        const agentId = await startWorker(taskId);
        console.log(`Started worker ${agentId} for task ${taskId}`);
        return agentId;
      } catch (error) {
        console.error(`Failed to start worker for task ${taskId}:`, error);
        throw error;
      }
    });

    return {
      success: true,
      taskId,
      agentId,
      message: `Worker ${agentId} started for task ${taskId}`,
    };
  }
);
