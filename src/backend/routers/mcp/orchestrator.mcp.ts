import { AgentType, ExecutionState, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import {
  killSupervisorAndCleanup,
  startSupervisorForTask,
} from '../../agents/supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../../agents/worker/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { verifyAgent } from './helpers.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Health threshold in minutes - agents not heard from in this time are unhealthy
 */
const HEALTH_THRESHOLD_MINUTES = 7;

// ============================================================================
// Input Schemas
// ============================================================================

const ListSupervisorsInputSchema = z.object({});

const CheckSupervisorHealthInputSchema = z.object({
  supervisorId: z.string().min(1, 'Supervisor ID is required'),
});

const CreateSupervisorInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
});

const RecoverSupervisorInputSchema = z.object({
  supervisorId: z.string().min(1, 'Supervisor ID is required'),
});

const ListPendingTopLevelTasksInputSchema = z.object({});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Verify agent is an ORCHESTRATOR
 */
async function verifyOrchestrator(
  context: McpToolContext
): Promise<{ success: true; agentId: string } | { success: false; error: McpToolResponse }> {
  const result = await verifyAgent(context, {
    requiredType: AgentType.ORCHESTRATOR,
    typeErrorMessage: 'Only ORCHESTRATOR agents can use orchestrator tools',
  });

  if (!result.success) {
    return result;
  }

  return { success: true, agentId: result.agent.id };
}

/**
 * Calculate health status for an agent
 */
function calculateHealthStatus(lastActiveAt: Date): {
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
} {
  const now = Date.now();
  const minutesSinceHeartbeat = Math.floor((now - lastActiveAt.getTime()) / (60 * 1000));
  const isHealthy = minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES;
  return { isHealthy, minutesSinceHeartbeat };
}

interface SupervisorForRecovery {
  id: string;
  taskId: string;
  taskTitle: string;
}

/**
 * Validate supervisor exists and can be recovered
 */
async function validateSupervisorForRecovery(
  supervisorId: string
): Promise<
  { success: true; data: SupervisorForRecovery } | { success: false; error: McpToolResponse }
> {
  const supervisor = await agentAccessor.findById(supervisorId);
  if (!supervisor) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Supervisor with ID '${supervisorId}' not found`
      ),
    };
  }

  if (supervisor.type !== AgentType.SUPERVISOR) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        `Agent '${supervisorId}' is not a SUPERVISOR`
      ),
    };
  }

  if (!supervisor.currentTaskId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Supervisor '${supervisorId}' has no task assigned`
      ),
    };
  }

  const task = await taskAccessor.findById(supervisor.currentTaskId);
  if (!task) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${supervisor.currentTaskId}' not found`
      ),
    };
  }

  return {
    success: true,
    data: { id: supervisor.id, taskId: supervisor.currentTaskId, taskTitle: task.title },
  };
}

/**
 * Kill all workers for a top-level task and mark them as FAILED
 */
async function killTaskWorkers(taskId: string): Promise<string[]> {
  const workers = await agentAccessor.findWorkersByTopLevelTaskId(taskId);
  const killedWorkers: string[] = [];

  for (const worker of workers) {
    try {
      await killWorkerAndCleanup(worker.id);
      killedWorkers.push(worker.id);
    } catch (error) {
      console.error(`Failed to kill worker ${worker.id}:`, error);
    }
    await agentAccessor.update(worker.id, { executionState: ExecutionState.CRASHED });
  }

  return killedWorkers;
}

/**
 * Reset non-terminal tasks to PENDING state
 */
async function resetTopLevelTaskSubtasks(
  taskId: string
): Promise<{ resetTasks: string[]; totalTasks: number }> {
  const tasks = await taskAccessor.list({ parentId: taskId });
  const resetTasks: string[] = [];

  for (const task of tasks) {
    if (task.state === TaskState.COMPLETED || task.state === TaskState.FAILED) {
      continue;
    }
    await taskAccessor.update(task.id, { state: TaskState.PENDING, assignedAgentId: null });
    resetTasks.push(task.id);
  }

  return { resetTasks, totalTasks: tasks.length };
}

/**
 * Try to create a new supervisor for a task
 */
async function tryCreateNewSupervisor(taskId: string): Promise<string | null> {
  try {
    return await startSupervisorForTask(taskId);
  } catch (error) {
    console.error(`Failed to create new supervisor for task ${taskId}:`, error);
    return null;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all supervisors with health status (ORCHESTRATOR only)
 */
async function listSupervisors(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    ListSupervisorsInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get all supervisors with health status
    const supervisors = await agentAccessor.getAgentsWithHealthStatus(
      AgentType.SUPERVISOR,
      HEALTH_THRESHOLD_MINUTES
    );

    // Enrich with task info
    const supervisorList = await Promise.all(
      supervisors.map(async (s) => {
        const task = s.currentTaskId ? await taskAccessor.findById(s.currentTaskId) : null;
        return {
          id: s.id,
          executionState: s.executionState,
          taskId: s.currentTaskId,
          taskTitle: task?.title ?? null,
          taskState: task?.state ?? null,
          tmuxSessionName: s.tmuxSessionName,
          isHealthy: s.isHealthy,
          minutesSinceHeartbeat: s.minutesSinceHeartbeat,
          lastHeartbeat: s.lastHeartbeat,
          createdAt: s.createdAt,
        };
      })
    );

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__list_supervisors',
      'result',
      {
        totalSupervisors: supervisorList.length,
        healthySupervisors: supervisorList.filter((s) => s.isHealthy).length,
        unhealthySupervisors: supervisorList.filter((s) => !s.isHealthy).length,
      }
    );

    return createSuccessResponse({
      supervisors: supervisorList,
      summary: {
        total: supervisorList.length,
        healthy: supervisorList.filter((s) => s.isHealthy).length,
        unhealthy: supervisorList.filter((s) => !s.isHealthy).length,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Check health of a specific supervisor (ORCHESTRATOR only)
 */
async function checkSupervisorHealth(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = CheckSupervisorHealthInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get supervisor
    const supervisor = await agentAccessor.findById(validatedInput.supervisorId);
    if (!supervisor) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Supervisor with ID '${validatedInput.supervisorId}' not found`
      );
    }

    if (supervisor.type !== AgentType.SUPERVISOR) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        `Agent '${validatedInput.supervisorId}' is not a SUPERVISOR`
      );
    }

    // Calculate health status
    const { isHealthy, minutesSinceHeartbeat } = calculateHealthStatus(
      supervisor.lastHeartbeat ?? supervisor.createdAt
    );

    // Get task info
    const task = supervisor.currentTaskId
      ? await taskAccessor.findById(supervisor.currentTaskId)
      : null;

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__check_supervisor_health',
      'result',
      {
        supervisorId: supervisor.id,
        isHealthy,
        minutesSinceHeartbeat,
        executionState: supervisor.executionState,
      }
    );

    return createSuccessResponse({
      supervisorId: supervisor.id,
      isHealthy,
      minutesSinceHeartbeat,
      lastHeartbeat: supervisor.lastHeartbeat,
      executionState: supervisor.executionState,
      taskId: supervisor.currentTaskId,
      taskTitle: task?.title || null,
      tmuxSessionName: supervisor.tmuxSessionName,
      healthThresholdMinutes: HEALTH_THRESHOLD_MINUTES,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Create a new supervisor for a task (ORCHESTRATOR only)
 */
async function createSupervisor(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateSupervisorInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Check task exists
    const task = await taskAccessor.findById(validatedInput.taskId);
    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${validatedInput.taskId}' not found`
      );
    }

    // Check if task already has a supervisor
    const existingSupervisor = await agentAccessor.findByTopLevelTaskId(validatedInput.taskId);
    if (existingSupervisor) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Task '${validatedInput.taskId}' already has a supervisor (${existingSupervisor.id})`
      );
    }

    // Create and start supervisor
    const supervisorId = await startSupervisorForTask(validatedInput.taskId);

    // Get supervisor details
    const supervisor = await agentAccessor.findById(supervisorId);

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__create_supervisor',
      'result',
      {
        supervisorId,
        taskId: validatedInput.taskId,
        taskTitle: task.title,
        tmuxSessionName: supervisor?.tmuxSessionName,
      }
    );

    return createSuccessResponse({
      supervisorId,
      taskId: validatedInput.taskId,
      taskTitle: task.title,
      tmuxSessionName: supervisor?.tmuxSessionName,
      message: `Supervisor ${supervisorId} created for task: ${task.title}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    // Re-throw other errors with context
    if (error instanceof Error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to create supervisor: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Recover a crashed supervisor with cascading worker cleanup (ORCHESTRATOR only)
 * This performs the full cascading recovery:
 * 1. Kill all workers for the task
 * 2. Kill the supervisor
 * 3. Reset subtask states (non-completed tasks back to PENDING)
 * 4. Create new supervisor
 * 5. Notify human
 */
async function recoverSupervisor(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = RecoverSupervisorInputSchema.parse(input);

    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    const supervisorValidation = await validateSupervisorForRecovery(validatedInput.supervisorId);
    if (!supervisorValidation.success) {
      return supervisorValidation.error;
    }
    const { id: oldSupervisorId, taskId, taskTitle } = supervisorValidation.data;

    // Phase 1: Kill all workers
    const killedWorkers = await killTaskWorkers(taskId);

    // Phase 2: Kill the supervisor
    try {
      await killSupervisorAndCleanup(oldSupervisorId);
    } catch (error) {
      console.error(`Failed to kill supervisor ${oldSupervisorId}:`, error);
    }
    await agentAccessor.update(oldSupervisorId, {
      executionState: ExecutionState.CRASHED,
      currentTaskId: null,
    });

    // Phase 3: Reset subtask states
    const { resetTasks, totalTasks } = await resetTopLevelTaskSubtasks(taskId);

    // Phase 4: Create new supervisor
    const newSupervisorId = await tryCreateNewSupervisor(taskId);

    // Phase 5: Notify human
    const newSupervisorStatus = newSupervisorId || 'FAILED TO CREATE';
    const resumeMessage = newSupervisorId
      ? 'The new supervisor will resume work on pending tasks.'
      : 'WARNING: Failed to create new supervisor. Manual intervention required.';

    await mailAccessor.create({
      fromAgentId: context.agentId,
      isForHuman: true,
      subject: `Supervisor Crashed - Task: ${taskTitle}`,
      body: `A supervisor crash was detected and recovery was performed.

**Task**: ${taskTitle} (${taskId})
**Old Supervisor**: ${oldSupervisorId}
**New Supervisor**: ${newSupervisorStatus}

**Recovery Summary**:
- Workers killed: ${killedWorkers.length}
- Subtasks reset to PENDING: ${resetTasks.length}
- Subtasks kept (COMPLETED/FAILED): ${totalTasks - resetTasks.length}

${resumeMessage}`,
    });

    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__recover_supervisor',
      'result',
      {
        oldSupervisorId,
        newSupervisorId,
        taskId,
        taskTitle,
        workersKilled: killedWorkers.length,
        tasksReset: resetTasks.length,
        recoverySuccess: !!newSupervisorId,
      }
    );

    if (!newSupervisorId) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        'Recovery partially failed: workers killed and subtasks reset, but new supervisor creation failed. Manual intervention required.'
      );
    }

    return createSuccessResponse({
      oldSupervisorId,
      newSupervisorId,
      taskId,
      taskTitle,
      workersKilled: killedWorkers.length,
      tasksReset: resetTasks.length,
      message: `Supervisor recovered. ${killedWorkers.length} workers killed, ${resetTasks.length} subtasks reset. New supervisor ${newSupervisorId} created.`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * List top-level tasks that are pending (need supervisors) (ORCHESTRATOR only)
 */
async function listPendingTopLevelTasks(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    ListPendingTopLevelTasksInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get all top-level tasks
    const topLevelTasks = await taskAccessor.list({ isTopLevel: true });

    // Filter to tasks in PLANNING state without supervisors
    const pendingTasks = await Promise.all(
      topLevelTasks
        .filter((t) => t.state === TaskState.PLANNING)
        .map(async (task) => {
          const supervisor = await agentAccessor.findByTopLevelTaskId(task.id);
          return {
            task,
            hasSupervisor: !!supervisor,
          };
        })
    );

    const tasksNeedingSupervisors = pendingTasks
      .filter((p) => !p.hasSupervisor)
      .map((p) => ({
        id: p.task.id,
        title: p.task.title,
        description: p.task.description,
        createdAt: p.task.createdAt,
      }));

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__list_pending_top_level_tasks',
      'result',
      {
        totalPendingTasks: tasksNeedingSupervisors.length,
      }
    );

    return createSuccessResponse({
      pendingTopLevelTasks: tasksNeedingSupervisors,
      count: tasksNeedingSupervisors.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerOrchestratorTools(): void {
  // Supervisor Management
  registerMcpTool({
    name: 'mcp__orchestrator__list_supervisors',
    description: 'List all supervisors with health status (ORCHESTRATOR only)',
    handler: listSupervisors,
    schema: ListSupervisorsInputSchema,
  });

  registerMcpTool({
    name: 'mcp__orchestrator__check_supervisor_health',
    description: 'Check health status of a specific supervisor (ORCHESTRATOR only)',
    handler: checkSupervisorHealth,
    schema: CheckSupervisorHealthInputSchema,
  });

  registerMcpTool({
    name: 'mcp__orchestrator__create_supervisor',
    description: 'Create a new supervisor for a task (ORCHESTRATOR only)',
    handler: createSupervisor,
    schema: CreateSupervisorInputSchema,
  });

  registerMcpTool({
    name: 'mcp__orchestrator__recover_supervisor',
    description:
      'Perform cascading recovery for a crashed supervisor: kill workers, reset tasks, recreate supervisor (ORCHESTRATOR only)',
    handler: recoverSupervisor,
    schema: RecoverSupervisorInputSchema,
  });

  // Task Management
  registerMcpTool({
    name: 'mcp__orchestrator__list_pending_top_level_tasks',
    description: 'List top-level tasks in PLANNING state that need supervisors (ORCHESTRATOR only)',
    handler: listPendingTopLevelTasks,
    schema: ListPendingTopLevelTasksInputSchema,
  });
}
