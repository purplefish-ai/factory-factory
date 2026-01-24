import { TaskState } from '@prisma-gen/client';
import { Router } from 'express';
import { z } from 'zod';
import {
  getSupervisorForTask,
  getSupervisorStatus,
  killSupervisorAndCleanup,
  listAllSupervisors,
  recreateSupervisor,
  startSupervisorForTask,
  stopSupervisorGracefully,
} from '../../agents/supervisor/lifecycle.js';
import { inngest } from '../../inngest/client.js';
import { taskAccessor } from '../../resource_accessors/index.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

const CreateEpicSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
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
 * Create a new top-level task (epic)
 */
router.post('/create', async (req, res) => {
  try {
    const validatedInput = CreateEpicSchema.parse(req.body);

    // Generate a placeholder linear issue ID if not provided
    const linearIssueId = validatedInput.linearIssueId || `manual-${Date.now()}`;
    const linearIssueUrl =
      validatedInput.linearIssueUrl || `https://linear.app/manual/${linearIssueId}`;

    // Create top-level task (epic)
    const task = await taskAccessor.create({
      projectId: validatedInput.projectId,
      parentId: null, // Top-level task (epic)
      title: validatedInput.title,
      description: validatedInput.description,
      linearIssueId,
      linearIssueUrl,
      state: TaskState.PLANNING,
    });

    // Fire task.top_level.created event to trigger supervisor creation
    try {
      await inngest.send({
        name: 'task.top_level.created',
        data: {
          taskId: task.id,
          linearIssueId: task.linearIssueId || '',
          title: task.title,
        },
      });
    } catch (error) {
      console.error('Failed to send task.top_level.created event:', error);
      // Continue anyway - event is optional
    }

    return res.status(201).json({
      success: true,
      data: {
        epicId: task.id,
        title: task.title,
        description: task.description,
        state: task.state,
        linearIssueId: task.linearIssueId,
        createdAt: task.createdAt,
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
 * Start a supervisor for a top-level task (epic)
 */
router.post('/start-supervisor', async (req, res) => {
  try {
    const validatedInput = StartSupervisorSchema.parse(req.body);

    // Verify top-level task (epic) exists
    const task = await taskAccessor.findById(validatedInput.epicId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Top-level task (epic) with ID '${validatedInput.epicId}' not found`,
        },
      });
    }

    // Verify it's a top-level task
    if (task.parentId !== null) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NOT_TOP_LEVEL_TASK',
          message: `Task '${validatedInput.epicId}' is not a top-level task (epic)`,
        },
      });
    }

    // Check if task already has a supervisor
    const existingSupervisor = await getSupervisorForTask(validatedInput.epicId);
    if (existingSupervisor) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'SUPERVISOR_EXISTS',
          message: `Task already has a supervisor (${existingSupervisor})`,
        },
      });
    }

    // Start supervisor
    const agentId = await startSupervisorForTask(validatedInput.epicId);

    // Get supervisor details
    const status = await getSupervisorStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        epicId: task.id,
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
          details: error.issues,
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
 * Get top-level task (epic) status including supervisor and child task info
 */
router.get('/status/:epicId', async (req, res) => {
  try {
    const epicId = req.params.epicId;

    // Get top-level task (epic)
    const task = await taskAccessor.findById(epicId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Top-level task (epic) with ID '${epicId}' not found`,
        },
      });
    }

    // Get supervisor status if exists
    let supervisorStatus = null;
    const supervisorId = await getSupervisorForTask(epicId);
    if (supervisorId) {
      try {
        supervisorStatus = await getSupervisorStatus(supervisorId);
      } catch {
        // Supervisor may have been deleted
      }
    }

    // Get all child tasks for this top-level task
    const childTasks = await taskAccessor.findByParentId(epicId);

    // Calculate summary
    const taskSummary = {
      total: childTasks.length,
      pending: childTasks.filter((t) => t.state === 'PENDING').length,
      assigned: childTasks.filter((t) => t.state === 'ASSIGNED').length,
      inProgress: childTasks.filter((t) => t.state === 'IN_PROGRESS').length,
      review: childTasks.filter((t) => t.state === 'REVIEW').length,
      blocked: childTasks.filter((t) => t.state === 'BLOCKED').length,
      completed: childTasks.filter((t) => t.state === 'COMPLETED').length,
      failed: childTasks.filter((t) => t.state === 'FAILED').length,
    };

    return res.status(200).json({
      success: true,
      data: {
        epicId: task.id,
        title: task.title,
        description: task.description,
        state: task.state,
        linearIssueId: task.linearIssueId,
        linearIssueUrl: task.linearIssueUrl,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        supervisor: supervisorStatus,
        taskSummary,
        tasks: childTasks.map((t) => ({
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
 * List all top-level tasks (epics), optionally filtered by projectId
 */
router.get('/list', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const topLevelTasks = await taskAccessor.list({
      projectId,
      isTopLevel: true,
    });

    return res.status(200).json({
      success: true,
      data: {
        epics: topLevelTasks.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          linearIssueId: t.linearIssueId,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
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
          details: error.issues,
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
          details: error.issues,
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

export { router as epicRouter };
