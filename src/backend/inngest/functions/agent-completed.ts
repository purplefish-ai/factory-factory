import { AgentState, AgentType } from '@prisma-gen/client';
import { killSupervisorAndCleanup } from '../../agents/supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../../agents/worker/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { inngest } from '../client.js';

/**
 * Handle agent.completed event
 *
 * This handler is triggered when an agent completes its work (success or failure).
 * It handles cleanup and notifications based on agent type:
 * - WORKER: Log completion, clean up tmux session, notify supervisor
 * - SUPERVISOR: Log completion, clean up tmux session, notify human of epic completion
 * - ORCHESTRATOR: Log (orchestrator runs indefinitely, so this is rare)
 */
export const agentCompletedHandler = inngest.createFunction(
  {
    id: 'agent-completed',
    name: 'Handle Agent Completed',
    retries: 2,
  },
  { event: 'agent.completed' },
  async ({ event, step }) => {
    const { agentId, taskId, epicId } = event.data;

    console.log(`Agent completed event received for agent ${agentId}`);

    // Step 1: Get agent information
    const agentInfo = await step.run('get-agent-info', async () => {
      const agent = await agentAccessor.findById(agentId);
      if (!agent) {
        console.warn(`Agent ${agentId} not found, may have already been cleaned up`);
        return null;
      }
      return {
        id: agent.id,
        type: agent.type,
        state: agent.state,
        currentEpicId: agent.currentEpicId,
        currentTaskId: agent.currentTaskId,
        tmuxSessionName: agent.tmuxSessionName,
      };
    });

    if (!agentInfo) {
      return {
        success: true,
        agentId,
        message: 'Agent not found, already cleaned up',
      };
    }

    // Step 2: Handle completion based on agent type
    const completionResult = await step.run('handle-completion', () => {
      switch (agentInfo.type) {
        case AgentType.WORKER:
          return handleWorkerCompletion(agentId, taskId, agentInfo.currentEpicId);

        case AgentType.SUPERVISOR:
          return handleSupervisorCompletion(
            agentId,
            epicId || agentInfo.currentEpicId || undefined
          );

        case AgentType.ORCHESTRATOR:
          return handleOrchestratorCompletion(agentId);

        default:
          return Promise.resolve({
            success: false,
            message: `Unknown agent type: ${agentInfo.type}`,
          });
      }
    });

    // Step 3: Update agent state to IDLE (or keep as is if already cleaned up)
    await step.run('update-agent-state', async () => {
      try {
        await agentAccessor.update(agentId, {
          state: AgentState.IDLE,
        });
      } catch (error) {
        // Agent may have been deleted during cleanup
        console.warn(`Could not update agent ${agentId} state:`, error);
      }
    });

    return {
      success: completionResult.success,
      agentId,
      agentType: agentInfo.type,
      message: completionResult.message,
    };
  }
);

/**
 * Handle worker completion
 */
async function handleWorkerCompletion(
  agentId: string,
  taskId: string | undefined,
  epicId: string | null
): Promise<{ success: boolean; message: string }> {
  try {
    // Get task info if available
    let taskTitle = 'Unknown task';
    let supervisorId: string | undefined;

    if (taskId) {
      const task = await taskAccessor.findById(taskId);
      if (task) {
        taskTitle = task.title;

        // Find supervisor for this epic
        if (task.epicId) {
          const supervisor = await agentAccessor.findByEpicId(task.epicId);
          supervisorId = supervisor?.id;
        }
      }
    }

    // Log completion
    await decisionLogAccessor.createManual(
      agentId,
      `Worker completed task "${taskTitle}"`,
      `Worker agent completed work on task`,
      JSON.stringify({ taskId, epicId })
    );

    // Clean up worker tmux session
    try {
      await killWorkerAndCleanup(agentId);
      console.log(`Cleaned up worker ${agentId} tmux session`);
    } catch (error) {
      console.warn(`Could not clean up worker ${agentId}:`, error);
    }

    // Notify supervisor if found
    if (supervisorId) {
      await mailAccessor.create({
        fromAgentId: agentId,
        toAgentId: supervisorId,
        subject: `Worker completed: ${taskTitle}`,
        body:
          `Worker ${agentId} has completed work on task "${taskTitle}".\n\n` +
          `Task ID: ${taskId}\n` +
          `The task should now be ready for review.`,
      });
    }

    return {
      success: true,
      message: `Worker ${agentId} completed and cleaned up`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Worker completion handling failed: ${errorMessage}`,
    };
  }
}

/**
 * Handle supervisor completion
 */
async function handleSupervisorCompletion(
  agentId: string,
  epicId: string | undefined
): Promise<{ success: boolean; message: string }> {
  try {
    // Get epic info if available
    let epicTitle = 'Unknown epic';

    if (epicId) {
      const epic = await epicAccessor.findById(epicId);
      if (epic) {
        epicTitle = epic.title;
      }
    }

    // Log completion
    await decisionLogAccessor.createManual(
      agentId,
      `Supervisor completed epic "${epicTitle}"`,
      `Supervisor agent completed work on epic`,
      JSON.stringify({ epicId })
    );

    // Clean up supervisor tmux session
    try {
      await killSupervisorAndCleanup(agentId);
      console.log(`Cleaned up supervisor ${agentId} tmux session`);
    } catch (error) {
      console.warn(`Could not clean up supervisor ${agentId}:`, error);
    }

    // Notify human about epic completion
    await mailAccessor.create({
      fromAgentId: agentId,
      isForHuman: true,
      subject: `Epic completed: ${epicTitle}`,
      body:
        `The supervisor has completed work on epic "${epicTitle}".\n\n` +
        `Epic ID: ${epicId}\n` +
        `Supervisor ID: ${agentId}\n\n` +
        `The epic should now be ready for your review. Check the epic PR for the final changes.`,
    });

    return {
      success: true,
      message: `Supervisor ${agentId} completed and cleaned up`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Supervisor completion handling failed: ${errorMessage}`,
    };
  }
}

/**
 * Handle orchestrator completion (rare - orchestrator normally runs indefinitely)
 */
async function handleOrchestratorCompletion(
  agentId: string
): Promise<{ success: boolean; message: string }> {
  try {
    // Log completion (this is unusual)
    await decisionLogAccessor.createManual(
      agentId,
      `Orchestrator completed`,
      `Orchestrator agent stopped (this is unusual - orchestrator normally runs indefinitely)`,
      JSON.stringify({ agentId })
    );

    // Notify human - orchestrator stopping is noteworthy
    await mailAccessor.create({
      fromAgentId: agentId,
      isForHuman: true,
      subject: `NOTICE: Orchestrator has stopped`,
      body:
        `The orchestrator agent has stopped running.\n\n` +
        `Orchestrator ID: ${agentId}\n\n` +
        `This is unusual behavior - the orchestrator should run indefinitely.\n` +
        `You may need to restart the orchestrator manually.`,
    });

    return {
      success: true,
      message: `Orchestrator ${agentId} completion logged`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Orchestrator completion handling failed: ${errorMessage}`,
    };
  }
}
