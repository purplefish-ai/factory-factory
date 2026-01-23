import { EpicState } from '@prisma-gen/client';
import { Router } from 'express';
import { z } from 'zod';
import {
  getSupervisorForEpic,
  getSupervisorStatus,
  killSupervisorAndCleanup,
  listAllSupervisors,
  recreateSupervisor,
  startSupervisorForEpic,
  stopSupervisorGracefully,
} from '../../agents/supervisor/lifecycle.js';
import { inngest } from '../../inngest/client.js';
import { epicAccessor, taskAccessor } from '../../resource_accessors/index.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

const CreateEpicSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  linearIssueId: z.string().optional(), // Optional for manual creation
  linearIssueUrl: z.string().optional(),
});

const StartSupervisorSchema = z.object({
  epicId: z.string(),
});

const StopSupervisorSchema = z.object({
  agentId: z.string(),
});

const KillSupervisorSchema = z.object({
  agentId: z.string(),
});

const RecreateSupervisorSchema = z.object({
  epicId: z.string(),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/epics/create
 * Create a new epic
 */
router.post('/create', async (req, res) => {
  try {
    const validatedInput = CreateEpicSchema.parse(req.body);

    // Generate a placeholder linear issue ID if not provided
    const linearIssueId = validatedInput.linearIssueId || `manual-${Date.now()}`;
    const linearIssueUrl =
      validatedInput.linearIssueUrl || `https://linear.app/manual/${linearIssueId}`;

    // Create epic
    const epic = await epicAccessor.create({
      title: validatedInput.title,
      description: validatedInput.description,
      linearIssueId,
      linearIssueUrl,
      state: EpicState.PLANNING,
    });

    // Fire epic.created event
    try {
      await inngest.send({
        name: 'epic.created',
        data: {
          epicId: epic.id,
          linearIssueId: epic.linearIssueId,
          title: epic.title,
        },
      });
    } catch (error) {
      console.error('Failed to send epic.created event:', error);
      // Continue anyway - event is optional
    }

    return res.status(201).json({
      success: true,
      data: {
        epicId: epic.id,
        title: epic.title,
        description: epic.description,
        state: epic.state,
        linearIssueId: epic.linearIssueId,
        createdAt: epic.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.errors,
        },
      });
    }

    console.error('Error creating epic:', error);
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
 * POST /api/epics/start-supervisor
 * Start a supervisor for an epic
 */
router.post('/start-supervisor', async (req, res) => {
  try {
    const validatedInput = StartSupervisorSchema.parse(req.body);

    // Verify epic exists
    const epic = await epicAccessor.findById(validatedInput.epicId);
    if (!epic) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic with ID '${validatedInput.epicId}' not found`,
        },
      });
    }

    // Check if epic already has a supervisor
    const existingSupervisor = await getSupervisorForEpic(validatedInput.epicId);
    if (existingSupervisor) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'SUPERVISOR_EXISTS',
          message: `Epic already has a supervisor (${existingSupervisor})`,
        },
      });
    }

    // Start supervisor
    const agentId = await startSupervisorForEpic(validatedInput.epicId);

    // Get supervisor details
    const status = await getSupervisorStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        epicId: epic.id,
        tmuxSession: status.tmuxSession,
        isRunning: status.isRunning,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.errors,
        },
      });
    }

    console.error('Error starting supervisor:', error);
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
 * GET /api/epics/status/:epicId
 * Get epic status including supervisor and task info
 */
router.get('/status/:epicId', async (req, res) => {
  try {
    const epicId = req.params.epicId;

    // Get epic
    const epic = await epicAccessor.findById(epicId);
    if (!epic) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic with ID '${epicId}' not found`,
        },
      });
    }

    // Get supervisor status if exists
    let supervisorStatus = null;
    const supervisorId = await getSupervisorForEpic(epicId);
    if (supervisorId) {
      try {
        supervisorStatus = await getSupervisorStatus(supervisorId);
      } catch {
        // Supervisor may have been deleted
      }
    }

    // Get all tasks for epic
    const tasks = await taskAccessor.list({ epicId });

    // Calculate summary
    const taskSummary = {
      total: tasks.length,
      pending: tasks.filter((t) => t.state === 'PENDING').length,
      assigned: tasks.filter((t) => t.state === 'ASSIGNED').length,
      inProgress: tasks.filter((t) => t.state === 'IN_PROGRESS').length,
      review: tasks.filter((t) => t.state === 'REVIEW').length,
      blocked: tasks.filter((t) => t.state === 'BLOCKED').length,
      completed: tasks.filter((t) => t.state === 'COMPLETED').length,
      failed: tasks.filter((t) => t.state === 'FAILED').length,
    };

    return res.status(200).json({
      success: true,
      data: {
        epicId: epic.id,
        title: epic.title,
        description: epic.description,
        state: epic.state,
        linearIssueId: epic.linearIssueId,
        linearIssueUrl: epic.linearIssueUrl,
        createdAt: epic.createdAt,
        updatedAt: epic.updatedAt,
        completedAt: epic.completedAt,
        supervisor: supervisorStatus,
        taskSummary,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          assignedAgentId: t.assignedAgentId,
          prUrl: t.prUrl,
        })),
      },
    });
  } catch (error) {
    console.error('Error getting epic status:', error);
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
 * GET /api/epics/list
 * List all epics
 */
router.get('/list', async (_req, res) => {
  try {
    const epics = await epicAccessor.list();

    return res.status(200).json({
      success: true,
      data: {
        epics: epics.map((e) => ({
          id: e.id,
          title: e.title,
          state: e.state,
          linearIssueId: e.linearIssueId,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        })),
      },
    });
  } catch (error) {
    console.error('Error listing epics:', error);
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
 * GET /api/epics/supervisors
 * List all supervisors
 */
router.get('/supervisors', async (_req, res) => {
  try {
    const supervisors = await listAllSupervisors();

    return res.status(200).json({
      success: true,
      data: {
        supervisors,
      },
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
 * POST /api/epics/stop-supervisor
 * Stop a supervisor gracefully
 */
router.post('/stop-supervisor', async (req, res) => {
  try {
    const validatedInput = StopSupervisorSchema.parse(req.body);

    await stopSupervisorGracefully(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Supervisor stopped successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.errors,
        },
      });
    }

    console.error('Error stopping supervisor:', error);
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
 * POST /api/epics/kill-supervisor
 * Kill a supervisor and clean up resources
 */
router.post('/kill-supervisor', async (req, res) => {
  try {
    const validatedInput = KillSupervisorSchema.parse(req.body);

    await killSupervisorAndCleanup(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Supervisor killed and cleaned up successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.errors,
        },
      });
    }

    console.error('Error killing supervisor:', error);
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
 * POST /api/epics/recreate-supervisor
 * Recreate a supervisor for an epic
 */
router.post('/recreate-supervisor', async (req, res) => {
  try {
    const validatedInput = RecreateSupervisorSchema.parse(req.body);

    const agentId = await recreateSupervisor(validatedInput.epicId);
    const status = await getSupervisorStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        epicId: validatedInput.epicId,
        tmuxSession: status.tmuxSession,
        isRunning: status.isRunning,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid input',
          details: error.errors,
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

export { router as epicRouter };
