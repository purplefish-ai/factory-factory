import { TaskState } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import {
  getWorkerStatus,
  killWorkerAndCleanup,
  recreateWorker,
  startWorker,
  stopWorkerGracefully,
} from '../../agents/worker/lifecycle.js';
import { inngest } from '../../inngest/client.js';
import { epicAccessor, taskAccessor } from '../../resource_accessors/index.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

const CreateTaskSchema = z.object({
  epicId: z.string(),
  title: z.string(),
  description: z.string().optional(),
});

const StartWorkerSchema = z.object({
  taskId: z.string(),
});

const StopWorkerSchema = z.object({
  agentId: z.string(),
});

const KillWorkerSchema = z.object({
  agentId: z.string(),
});

const RecreateWorkerSchema = z.object({
  taskId: z.string(),
});

const CancelTaskSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/tasks/create
 * Create a new task for an epic
 */
router.post('/create', async (req, res) => {
  try {
    const validatedInput = CreateTaskSchema.parse(req.body);

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

    // Create task
    const task = await taskAccessor.create({
      epicId: validatedInput.epicId,
      title: validatedInput.title,
      description: validatedInput.description,
      state: TaskState.PENDING,
    });

    // Fire task.created event (if Inngest is configured)
    try {
      await inngest.send({
        name: 'task.created',
        data: {
          taskId: task.id,
          epicId: task.epicId,
          title: task.title,
        },
      });
    } catch (error) {
      console.error('Failed to send task.created event:', error);
      // Continue anyway - event is optional in Phase 2
    }

    return res.status(201).json({
      success: true,
      data: {
        taskId: task.id,
        epicId: task.epicId,
        title: task.title,
        state: task.state,
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
          details: error.errors,
        },
      });
    }

    console.error('Error creating task:', error);
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
 * POST /api/tasks/start-worker
 * Start a worker for a task
 */
router.post('/start-worker', async (req, res) => {
  try {
    const validatedInput = StartWorkerSchema.parse(req.body);

    // Verify task exists
    const task = await taskAccessor.findById(validatedInput.taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task with ID '${validatedInput.taskId}' not found`,
        },
      });
    }

    // Start worker
    const agentId = await startWorker(validatedInput.taskId);

    // Get agent details
    const status = await getWorkerStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        taskId: task.id,
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

    console.error('Error starting worker:', error);
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
 * GET /api/tasks/status/:taskId
 * Get task status including worker info
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    const taskId = req.params.taskId;

    // Get task
    const task = await taskAccessor.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task with ID '${taskId}' not found`,
        },
      });
    }

    // Get worker status if assigned
    let workerStatus = null;
    if (task.assignedAgentId) {
      try {
        workerStatus = await getWorkerStatus(task.assignedAgentId);
      } catch {
        // Worker may have been deleted
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        taskId: task.id,
        title: task.title,
        description: task.description,
        state: task.state,
        assignedAgentId: task.assignedAgentId,
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        prUrl: task.prUrl,
        failureReason: task.failureReason,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        worker: workerStatus,
      },
    });
  } catch (error) {
    console.error('Error getting task status:', error);
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
 * POST /api/tasks/stop-worker
 * Stop a worker gracefully
 */
router.post('/stop-worker', async (req, res) => {
  try {
    const validatedInput = StopWorkerSchema.parse(req.body);

    await stopWorkerGracefully(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Worker stopped successfully',
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

    console.error('Error stopping worker:', error);
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
 * POST /api/tasks/kill-worker
 * Kill a worker and clean up resources
 */
router.post('/kill-worker', async (req, res) => {
  try {
    const validatedInput = KillWorkerSchema.parse(req.body);

    await killWorkerAndCleanup(validatedInput.agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId: validatedInput.agentId,
        message: 'Worker killed and cleaned up successfully',
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

    console.error('Error killing worker:', error);
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
 * POST /api/tasks/recreate-worker
 * Recreate a worker for a task
 */
router.post('/recreate-worker', async (req, res) => {
  try {
    const validatedInput = RecreateWorkerSchema.parse(req.body);

    const agentId = await recreateWorker(validatedInput.taskId);
    const status = await getWorkerStatus(agentId);

    return res.status(200).json({
      success: true,
      data: {
        agentId,
        taskId: validatedInput.taskId,
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

    console.error('Error recreating worker:', error);
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
 * POST /api/tasks/cancel
 * Cancel a task (mark as FAILED with reason)
 */
router.post('/cancel', async (req, res) => {
  try {
    const validatedInput = CancelTaskSchema.parse(req.body);

    // Get task
    const task = await taskAccessor.findById(validatedInput.taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task with ID '${validatedInput.taskId}' not found`,
        },
      });
    }

    // Don't cancel already completed tasks
    if (task.state === TaskState.COMPLETED) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATE',
          message: `Task '${validatedInput.taskId}' is already completed`,
        },
      });
    }

    // Kill worker if assigned
    if (task.assignedAgentId) {
      try {
        await killWorkerAndCleanup(task.assignedAgentId);
      } catch (error) {
        console.error(`Failed to kill worker ${task.assignedAgentId}:`, error);
        // Continue anyway
      }
    }

    // Mark task as FAILED
    const updatedTask = await taskAccessor.update(validatedInput.taskId, {
      state: TaskState.FAILED,
      failureReason: validatedInput.reason || 'Cancelled by user/system',
      assignedAgentId: null,
    });

    return res.status(200).json({
      success: true,
      data: {
        taskId: updatedTask.id,
        state: updatedTask.state,
        failureReason: updatedTask.failureReason,
        message: 'Task cancelled successfully',
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

    console.error('Error cancelling task:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

export { router as taskRouter };
