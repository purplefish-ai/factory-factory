import { AgentState, AgentType, EpicState, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import {
  killSupervisorAndCleanup,
  startSupervisorForEpic,
} from '../../agents/supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../../agents/worker/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
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
  epicId: z.string().min(1, 'Epic ID is required'),
});

const RecoverSupervisorInputSchema = z.object({
  supervisorId: z.string().min(1, 'Supervisor ID is required'),
});

const ListPendingEpicsInputSchema = z.object({});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Verify agent is an ORCHESTRATOR
 */
async function verifyOrchestrator(
  context: McpToolContext
): Promise<{ success: true; agentId: string } | { success: false; error: McpToolResponse }> {
  const agent = await agentAccessor.findById(context.agentId);
  if (!agent) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      ),
    };
  }

  if (agent.type !== AgentType.ORCHESTRATOR) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only ORCHESTRATOR agents can use orchestrator tools'
      ),
    };
  }

  return { success: true, agentId: agent.id };
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

    // Enrich with epic info
    const supervisorList = await Promise.all(
      supervisors.map(async (s) => {
        const epic = s.currentEpicId ? await epicAccessor.findById(s.currentEpicId) : null;
        return {
          id: s.id,
          state: s.state,
          epicId: s.currentEpicId,
          epicTitle: epic?.title || null,
          epicState: epic?.state || null,
          tmuxSessionName: s.tmuxSessionName,
          isHealthy: s.isHealthy,
          minutesSinceHeartbeat: s.minutesSinceHeartbeat,
          lastActiveAt: s.lastActiveAt,
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
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
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
    const { isHealthy, minutesSinceHeartbeat } = calculateHealthStatus(supervisor.lastActiveAt);

    // Get epic info
    const epic = supervisor.currentEpicId
      ? await epicAccessor.findById(supervisor.currentEpicId)
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
        state: supervisor.state,
      }
    );

    return createSuccessResponse({
      supervisorId: supervisor.id,
      isHealthy,
      minutesSinceHeartbeat,
      lastActiveAt: supervisor.lastActiveAt,
      state: supervisor.state,
      epicId: supervisor.currentEpicId,
      epicTitle: epic?.title || null,
      tmuxSessionName: supervisor.tmuxSessionName,
      healthThresholdMinutes: HEALTH_THRESHOLD_MINUTES,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
    }
    throw error;
  }
}

/**
 * Create a new supervisor for an epic (ORCHESTRATOR only)
 */
async function createSupervisor(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateSupervisorInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Check epic exists
    const epic = await epicAccessor.findById(validatedInput.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${validatedInput.epicId}' not found`
      );
    }

    // Check if epic already has a supervisor
    const existingSupervisor = await agentAccessor.findByEpicId(validatedInput.epicId);
    if (existingSupervisor) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Epic '${validatedInput.epicId}' already has a supervisor (${existingSupervisor.id})`
      );
    }

    // Create and start supervisor
    const supervisorId = await startSupervisorForEpic(validatedInput.epicId);

    // Get supervisor details
    const supervisor = await agentAccessor.findById(supervisorId);

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__create_supervisor',
      'result',
      {
        supervisorId,
        epicId: validatedInput.epicId,
        epicTitle: epic.title,
        tmuxSessionName: supervisor?.tmuxSessionName,
      }
    );

    return createSuccessResponse({
      supervisorId,
      epicId: validatedInput.epicId,
      epicTitle: epic.title,
      tmuxSessionName: supervisor?.tmuxSessionName,
      message: `Supervisor ${supervisorId} created for epic: ${epic.title}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
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
 * 1. Kill all workers for the epic
 * 2. Kill the supervisor
 * 3. Reset task states (non-completed tasks back to PENDING)
 * 4. Create new supervisor
 * 5. Notify human
 */
async function recoverSupervisor(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = RecoverSupervisorInputSchema.parse(input);

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

    if (!supervisor.currentEpicId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Supervisor '${validatedInput.supervisorId}' has no epic assigned`
      );
    }

    const epicId = supervisor.currentEpicId;

    // Get epic
    const epic = await epicAccessor.findById(epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${epicId}' not found`
      );
    }

    // ========================================================================
    // Phase 1: Kill all workers for this epic
    // ========================================================================
    const workers = await agentAccessor.findWorkersByEpicId(epicId);
    const killedWorkers: string[] = [];

    for (const worker of workers) {
      try {
        await killWorkerAndCleanup(worker.id);
        killedWorkers.push(worker.id);
      } catch (error) {
        console.error(`Failed to kill worker ${worker.id}:`, error);
        // Continue with other workers
      }

      // Mark worker as FAILED
      await agentAccessor.update(worker.id, {
        state: AgentState.FAILED,
      });
    }

    // ========================================================================
    // Phase 2: Kill the supervisor
    // ========================================================================
    try {
      await killSupervisorAndCleanup(supervisor.id);
    } catch (error) {
      console.error(`Failed to kill supervisor ${supervisor.id}:`, error);
      // Continue anyway
    }

    // Mark supervisor as FAILED and clear its epic assignment
    // (this allows a new supervisor to be created for the epic)
    await agentAccessor.update(supervisor.id, {
      state: AgentState.FAILED,
      currentEpicId: null,
    });

    // ========================================================================
    // Phase 3: Reset task states
    // ========================================================================
    const tasks = await taskAccessor.list({ epicId });
    const resetTasks: string[] = [];

    for (const task of tasks) {
      // Keep COMPLETED and FAILED tasks as-is
      if (task.state === TaskState.COMPLETED || task.state === TaskState.FAILED) {
        continue;
      }

      // Reset all other states to PENDING
      await taskAccessor.update(task.id, {
        state: TaskState.PENDING,
        assignedAgentId: null,
      });
      resetTasks.push(task.id);
    }

    // ========================================================================
    // Phase 4: Create new supervisor
    // ========================================================================
    // First, clear the epic's supervisor relation by setting currentEpicId to null on the old supervisor
    // The old supervisor is already marked as FAILED and the unique constraint should be released

    let newSupervisorId: string | null = null;
    try {
      newSupervisorId = await startSupervisorForEpic(epicId);
    } catch (error) {
      console.error(`Failed to create new supervisor for epic ${epicId}:`, error);
      // Continue to notification phase even if supervisor creation fails
    }

    // ========================================================================
    // Phase 5: Notify human
    // ========================================================================
    await mailAccessor.create({
      fromAgentId: context.agentId,
      isForHuman: true,
      subject: `Supervisor Crashed - Epic: ${epic.title}`,
      body: `A supervisor crash was detected and recovery was performed.

**Epic**: ${epic.title} (${epicId})
**Old Supervisor**: ${supervisor.id}
**New Supervisor**: ${newSupervisorId || 'FAILED TO CREATE'}

**Recovery Summary**:
- Workers killed: ${killedWorkers.length}
- Tasks reset to PENDING: ${resetTasks.length}
- Tasks kept (COMPLETED/FAILED): ${tasks.length - resetTasks.length}

${newSupervisorId ? 'The new supervisor will resume work on pending tasks.' : 'WARNING: Failed to create new supervisor. Manual intervention required.'}`,
    });

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__recover_supervisor',
      'result',
      {
        oldSupervisorId: supervisor.id,
        newSupervisorId,
        epicId,
        epicTitle: epic.title,
        workersKilled: killedWorkers.length,
        tasksReset: resetTasks.length,
        recoverySuccess: !!newSupervisorId,
      }
    );

    if (!newSupervisorId) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Recovery partially failed: workers killed and tasks reset, but new supervisor creation failed. Manual intervention required.`
      );
    }

    return createSuccessResponse({
      oldSupervisorId: supervisor.id,
      newSupervisorId,
      epicId,
      epicTitle: epic.title,
      workersKilled: killedWorkers.length,
      tasksReset: resetTasks.length,
      message: `Supervisor recovered. ${killedWorkers.length} workers killed, ${resetTasks.length} tasks reset. New supervisor ${newSupervisorId} created.`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
    }
    throw error;
  }
}

/**
 * List epics that are pending (need supervisors) (ORCHESTRATOR only)
 */
async function listPendingEpics(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    ListPendingEpicsInputSchema.parse(input);

    // Verify orchestrator
    const verification = await verifyOrchestrator(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get all epics
    const epics = await epicAccessor.list();

    // Filter to epics in PLANNING state without supervisors
    const pendingEpics = await Promise.all(
      epics
        .filter((e) => e.state === EpicState.PLANNING)
        .map(async (epic) => {
          const supervisor = await agentAccessor.findByEpicId(epic.id);
          return {
            epic,
            hasSupervisor: !!supervisor,
          };
        })
    );

    const epicsNeedingSupervisors = pendingEpics
      .filter((p) => !p.hasSupervisor)
      .map((p) => ({
        id: p.epic.id,
        title: p.epic.title,
        description: p.epic.description,
        linearIssueId: p.epic.linearIssueId,
        createdAt: p.epic.createdAt,
      }));

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__orchestrator__list_pending_epics',
      'result',
      {
        totalPendingEpics: epicsNeedingSupervisors.length,
      }
    );

    return createSuccessResponse({
      pendingEpics: epicsNeedingSupervisors,
      count: epicsNeedingSupervisors.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
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
    description: 'Create a new supervisor for an epic (ORCHESTRATOR only)',
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

  // Epic Management
  registerMcpTool({
    name: 'mcp__orchestrator__list_pending_epics',
    description: 'List epics in PLANNING state that need supervisors (ORCHESTRATOR only)',
    handler: listPendingEpics,
    schema: ListPendingEpicsInputSchema,
  });
}
