import { AgentType } from '@prisma-gen/client';
import { Router } from 'express';
import { z } from 'zod';
import {
  checkSupervisorHealth,
  getPendingEpicsNeedingSupervisors,
  getSupervisorHealthSummary,
  recoverSupervisor,
} from '../../agents/orchestrator/health.js';
import {
  getOrchestrator,
  getOrchestratorStatus,
  killOrchestratorAndCleanup,
  startOrchestrator,
  stopOrchestratorGracefully,
} from '../../agents/orchestrator/lifecycle.js';
import { checkWorkerHealth, recoverWorker } from '../../agents/supervisor/health.js';
import { recreateSupervisor, runSupervisor } from '../../agents/supervisor/lifecycle.js';
import { agentAccessor } from '../../resource_accessors/index.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

const StopOrchestratorSchema = z.object({
  agentId: z.string(),
});

const KillOrchestratorSchema = z.object({
  agentId: z.string(),
});

const TriggerWorkerHealthCheckSchema = z.object({
  supervisorId: z.string(),
});

const TriggerSupervisorHealthCheckSchema = z.object({
  orchestratorId: z.string().optional(),
});

const TriggerWorkerRecoverySchema = z.object({
  workerId: z.string(),
  taskId: z.string(),
  supervisorId: z.string(),
});

const TriggerSupervisorRecoverySchema = z.object({
  supervisorId: z.string(),
  orchestratorId: z.string().optional(),
});

const RunSupervisorSchema = z.object({
  supervisorId: z.string(),
});

const RecreateSupervisorSchema = z.object({
  epicId: z.string(),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/orchestrator/start
 * Start the orchestrator (creates one if it doesn't exist)
 */
router.post('/start', async (_req, res) => {
  try {
    const agentId = await startOrchestrator();

    // Get orchestrator details
    const status = await getOrchestratorStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        isRunning: status.isRunning,
        tmuxSession: status.tmuxSession,
        message: `Orchestrator ${agentId} started successfully`,
      },
    });
  } catch (error) {
    console.error('Error starting orchestrator:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /api/orchestrator/status
 * Get the current orchestrator status
 */
router.get('/status', async (_req, res) => {
  try {
    const orchestratorId = await getOrchestrator();

    if (!orchestratorId) {
      return res.status(200).json({
        success: true,
        data: {
          exists: false,
          message: 'No orchestrator is currently running',
        },
      });
    }

    const status = await getOrchestratorStatus(orchestratorId);

    return res.status(200).json({
      success: true,
      data: {
        exists: true,
        ...status,
      },
    });
  } catch (error) {
    console.error('Error getting orchestrator status:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/stop
 * Stop the orchestrator gracefully
 */
router.post('/stop', async (req, res) => {
  try {
    const validatedInput = StopOrchestratorSchema.parse(req.body);

    await stopOrchestratorGracefully(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Orchestrator stopped successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error stopping orchestrator:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/kill
 * Kill the orchestrator and clean up resources
 */
router.post('/kill', async (req, res) => {
  try {
    const validatedInput = KillOrchestratorSchema.parse(req.body);

    await killOrchestratorAndCleanup(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Orchestrator killed and cleaned up successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error killing orchestrator:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /api/orchestrator/supervisors
 * List all supervisors with health status
 */
router.get('/supervisors', async (_req, res) => {
  try {
    const summary = await getSupervisorHealthSummary();

    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error('Error listing supervisors:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * GET /api/orchestrator/pending-epics
 * List epics that need supervisors
 */
router.get('/pending-epics', async (_req, res) => {
  try {
    const pendingEpics = await getPendingEpicsNeedingSupervisors();

    return res.status(200).json({
      success: true,
      data: {
        pendingEpics,
        count: pendingEpics.length,
      },
    });
  } catch (error) {
    console.error('Error listing pending epics:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/health-check/workers
 * Manually trigger worker health check for a supervisor
 */
router.post('/health-check/workers', async (req, res) => {
  try {
    const validatedInput = TriggerWorkerHealthCheckSchema.parse(req.body);

    const result = await checkWorkerHealth(validatedInput.supervisorId);

    return res.status(200).json({
      success: true,
      data: {
        supervisorId: validatedInput.supervisorId,
        ...result,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error checking worker health:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/health-check/supervisors
 * Manually trigger supervisor health check
 */
router.post('/health-check/supervisors', async (req, res) => {
  try {
    const validatedInput = TriggerSupervisorHealthCheckSchema.parse(req.body);

    // Get or use provided orchestrator ID
    let orchestratorId: string | undefined = validatedInput.orchestratorId;
    if (!orchestratorId) {
      const activeOrchestrator = await getOrchestrator();
      if (!activeOrchestrator) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_ORCHESTRATOR',
            message: 'No orchestrator is running. Start one first or provide orchestratorId.',
          },
        });
      }
      orchestratorId = activeOrchestrator;
    }

    const result = await checkSupervisorHealth(orchestratorId);

    return res.status(200).json({
      success: true,
      data: {
        orchestratorId,
        ...result,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error checking supervisor health:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/recover/worker
 * Manually trigger worker recovery
 */
router.post('/recover/worker', async (req, res) => {
  try {
    const validatedInput = TriggerWorkerRecoverySchema.parse(req.body);

    const result = await recoverWorker(
      validatedInput.workerId,
      validatedInput.taskId,
      validatedInput.supervisorId
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error recovering worker:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/recover/supervisor
 * Manually trigger supervisor cascading recovery
 */
router.post('/recover/supervisor', async (req, res) => {
  try {
    const validatedInput = TriggerSupervisorRecoverySchema.parse(req.body);

    // Get supervisor to find epicId
    const supervisor = await agentAccessor.findById(validatedInput.supervisorId);
    if (!supervisor) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Supervisor with ID '${validatedInput.supervisorId}' not found`,
        },
      });
    }

    if (supervisor.type !== AgentType.SUPERVISOR) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Agent '${validatedInput.supervisorId}' is not a SUPERVISOR`,
        },
      });
    }

    if (!supervisor.currentEpicId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATE',
          message: `Supervisor '${validatedInput.supervisorId}' has no epic assigned`,
        },
      });
    }

    // Get or use provided orchestrator ID
    let orchestratorId: string = validatedInput.orchestratorId ?? '';
    if (!orchestratorId) {
      const activeOrchestrator = await getOrchestrator();
      if (!activeOrchestrator) {
        // Create a temporary orchestrator ID for manual recovery
        orchestratorId = 'manual-recovery';
      } else {
        orchestratorId = activeOrchestrator;
      }
    }

    const result = await recoverSupervisor(
      validatedInput.supervisorId,
      supervisor.currentEpicId,
      orchestratorId
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error recovering supervisor:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/supervisor/run
 * Run an existing supervisor that has no tmux session
 */
router.post('/supervisor/run', async (req, res) => {
  try {
    const validatedInput = RunSupervisorSchema.parse(req.body);

    const supervisor = await agentAccessor.findById(validatedInput.supervisorId);
    if (!supervisor) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Supervisor with ID '${validatedInput.supervisorId}' not found`,
        },
      });
    }

    if (supervisor.type !== AgentType.SUPERVISOR) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Agent '${validatedInput.supervisorId}' is not a SUPERVISOR`,
        },
      });
    }

    // Run the supervisor (non-blocking)
    runSupervisor(validatedInput.supervisorId).catch((error) => {
      console.error(`Supervisor ${validatedInput.supervisorId} failed:`, error);
    });

    return res.status(200).json({
      success: true,
      data: {
        supervisorId: validatedInput.supervisorId,
        message: 'Supervisor started',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error running supervisor:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

/**
 * POST /api/orchestrator/supervisor/recreate
 * Recreate a supervisor for an epic (kills existing and creates new)
 */
router.post('/supervisor/recreate', async (req, res) => {
  try {
    const validatedInput = RecreateSupervisorSchema.parse(req.body);

    const newSupervisorId = await recreateSupervisor(validatedInput.epicId);

    return res.status(200).json({
      success: true,
      data: {
        epicId: validatedInput.epicId,
        supervisorId: newSupervisorId,
        message: 'Supervisor recreated successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.issues,
        },
      });
    }

    console.error('Error recreating supervisor:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export { router as orchestratorRouter };
