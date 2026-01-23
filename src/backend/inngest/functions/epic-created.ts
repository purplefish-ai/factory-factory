import { inngest } from '../client.js';
import { startSupervisorForEpic } from '../../agents/supervisor/lifecycle.js';
import { decisionLogAccessor, epicAccessor, mailAccessor } from '../../resource_accessors/index.js';

/**
 * Handle epic.created event by starting a supervisor agent
 *
 * This is the entry point for full automation:
 * 1. Epic is created (by human or via Linear)
 * 2. This handler fires automatically
 * 3. Supervisor is created for the epic
 * 4. Supervisor breaks down epic into tasks
 * 5. Workers are created automatically for each task (via task.created handler)
 */
export const epicCreatedHandler = inngest.createFunction(
  {
    id: 'epic-created',
    name: 'Handle Epic Created',
    retries: 3,
  },
  { event: 'epic.created' },
  async ({ event, step }) => {
    const { epicId, linearIssueId, title } = event.data;

    console.log(`Epic created event received for epic ${epicId} (Linear: ${linearIssueId})`);

    // Step 1: Verify epic exists and is ready for supervisor
    const epic = await step.run('verify-epic', async () => {
      const epic = await epicAccessor.findById(epicId);
      if (!epic) {
        throw new Error(`Epic with ID '${epicId}' not found`);
      }
      return {
        id: epic.id,
        title: epic.title,
        state: epic.state,
      };
    });

    // Step 2: Start supervisor for the epic
    const supervisorResult = await step.run('start-supervisor', async () => {
      try {
        const agentId = await startSupervisorForEpic(epicId);
        console.log(`Started supervisor ${agentId} for epic ${epicId}`);

        // Log the supervisor creation
        await decisionLogAccessor.createManual(
          agentId,
          `Supervisor created for epic "${title}"`,
          `Automatic supervisor creation triggered by epic.created event`,
          JSON.stringify({ epicId, linearIssueId, title })
        );

        return {
          success: true,
          agentId,
          message: `Supervisor ${agentId} started for epic ${epicId}`,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start supervisor for epic ${epicId}:`, error);

        // Send notification to human about failure
        await mailAccessor.create({
          isForHuman: true,
          subject: `Failed to create supervisor for epic: ${title}`,
          body: `The system failed to automatically create a supervisor for epic "${title}".\n\n` +
            `Epic ID: ${epicId}\n` +
            `Linear Issue: ${linearIssueId}\n` +
            `Error: ${errorMessage}\n\n` +
            `Manual intervention may be required.`,
        });

        throw error;
      }
    });

    return {
      success: supervisorResult.success,
      epicId,
      epicTitle: epic.title,
      supervisorId: supervisorResult.agentId,
      message: supervisorResult.message,
    };
  }
);
