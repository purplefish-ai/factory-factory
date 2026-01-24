import { startSupervisorForTask } from '../../agents/supervisor/lifecycle.js';
import { decisionLogAccessor, mailAccessor, taskAccessor } from '../../resource_accessors/index.js';
import { inngest } from '../client.js';

/**
 * Handle task.top_level.created event by starting a supervisor agent
 *
 * This is the entry point for full automation:
 * 1. Top-level task is created (by human or via Linear)
 * 2. This handler fires automatically
 * 3. Supervisor is created for the top-level task
 * 4. Supervisor breaks down the task into subtasks
 * 5. Workers are created automatically for each subtask (via task.created handler)
 */
export const topLevelTaskCreatedHandler = inngest.createFunction(
  {
    id: 'top-level-task-created',
    name: 'Handle Top-Level Task Created',
    retries: 3,
  },
  { event: 'task.top_level.created' },
  async ({ event, step }) => {
    const { taskId, linearIssueId, title } = event.data;

    console.log(
      `Top-level task created event received for task ${taskId} (Linear: ${linearIssueId})`
    );

    // Step 1: Verify top-level task exists and is ready for supervisor
    const topLevelTask = await step.run('verify-top-level-task', async () => {
      const task = await taskAccessor.findById(taskId);
      if (!task) {
        throw new Error(`Task with ID '${taskId}' not found`);
      }
      if (task.parentId !== null) {
        throw new Error(
          `Task '${taskId}' is not a top-level task (has parentId: ${task.parentId})`
        );
      }
      return {
        id: task.id,
        title: task.title,
        state: task.state,
      };
    });

    // Step 2: Start supervisor for the top-level task
    const supervisorResult = await step.run('start-supervisor', async () => {
      try {
        const agentId = await startSupervisorForTask(taskId);
        console.log(`Started supervisor ${agentId} for top-level task ${taskId}`);

        // Log the supervisor creation
        await decisionLogAccessor.createManual(
          agentId,
          `Supervisor created for top-level task "${title}"`,
          `Automatic supervisor creation triggered by task.top_level.created event`,
          JSON.stringify({ taskId, linearIssueId, title })
        );

        return {
          success: true,
          agentId,
          message: `Supervisor ${agentId} started for top-level task ${taskId}`,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start supervisor for top-level task ${taskId}:`, error);

        // Send notification to human about failure
        await mailAccessor.create({
          isForHuman: true,
          subject: `Failed to create supervisor for top-level task: ${title}`,
          body:
            `The system failed to automatically create a supervisor for top-level task "${title}".\n\n` +
            `Task ID: ${taskId}\n` +
            `Linear Issue: ${linearIssueId}\n` +
            `Error: ${errorMessage}\n\n` +
            `Manual intervention may be required.`,
        });

        throw error;
      }
    });

    return {
      success: supervisorResult.success,
      taskId,
      taskTitle: topLevelTask.title,
      supervisorId: supervisorResult.agentId,
      message: supervisorResult.message,
    };
  }
);
