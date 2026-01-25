import type { Task } from '@prisma-gen/client';
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
import {
  getWorkerStatus,
  killWorkerAndCleanup,
  recreateWorker,
  startWorker,
  stopWorkerGracefully,
} from '../../agents/worker/lifecycle.js';
import { inngest } from '../../inngest/client.js';
import { agentAccessor, taskAccessor } from '../../resource_accessors/index.js';
import type { TaskWithBasicRelations } from '../../resource_accessors/task.accessor.js';

const router = Router();

// ============================================================================
// Input Schemas
// ============================================================================

const CreateTaskSchema = z.object({
  projectId: z.string().optional(), // Required only for top-level tasks
  parentId: z.string().nullable().optional(), // null or undefined = top-level task
  title: z.string().min(1, 'Title is required'),
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

const StartSupervisorSchema = z.object({
  taskId: z.string(),
});

const StopSupervisorSchema = z.object({
  agentId: z.string(),
});

const KillSupervisorSchema = z.object({
  agentId: z.string(),
});

const RecreateSupervisorSchema = z.object({
  taskId: z.string(),
});

type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve project ID for task creation
 * For top-level tasks, uses the provided projectId
 * For child tasks, inherits from parent task
 */
async function resolveProjectId(
  input: CreateTaskInput,
  isTopLevel: boolean
): Promise<{ projectId: string } | { error: { code: string; message: string }; status: number }> {
  if (isTopLevel) {
    if (!input.projectId) {
      return {
        status: 400,
        error: {
          code: 'INVALID_INPUT',
          message: 'projectId is required for top-level tasks',
        },
      };
    }
    return { projectId: input.projectId };
  }

  const parentTask = await taskAccessor.findById(input.parentId as string);
  if (!parentTask) {
    return {
      status: 404,
      error: {
        code: 'PARENT_NOT_FOUND',
        message: `Parent task with ID '${input.parentId}' not found`,
      },
    };
  }
  return { projectId: parentTask.projectId };
}

/**
 * Fire task creation event
 */
async function fireTaskCreatedEvent(
  task: Task,
  isTopLevel: boolean,
  parentId?: string
): Promise<void> {
  try {
    if (isTopLevel) {
      await inngest.send({
        name: 'task.top_level.created',
        data: {
          taskId: task.id,
          title: task.title,
        },
      });
    } else if (parentId) {
      await inngest.send({
        name: 'task.created',
        data: {
          taskId: task.id,
          parentId,
          title: task.title,
        },
      });
    }
  } catch (error) {
    console.error('Failed to send task event:', error);
    // Continue anyway - event is optional
  }
}

/**
 * Calculate task state summary for child tasks
 */
function calculateTaskSummary(childTasks: TaskWithBasicRelations[]) {
  return {
    total: childTasks.length,
    pending: childTasks.filter((t) => t.state === 'PENDING').length,
    planning: childTasks.filter((t) => t.state === 'PLANNING').length,
    inProgress: childTasks.filter((t) => t.state === 'IN_PROGRESS').length,
    review: childTasks.filter((t) => t.state === 'REVIEW').length,
    blocked: childTasks.filter((t) => t.state === 'BLOCKED').length,
    completed: childTasks.filter((t) => t.state === 'COMPLETED').length,
    failed: childTasks.filter((t) => t.state === 'FAILED').length,
  };
}

/**
 * Build status response for a top-level task
 */
async function buildTopLevelTaskStatus(task: Task, baseData: Record<string, unknown>) {
  const taskId = task.id;
  let supervisorStatus = null;
  const supervisorId = await getSupervisorForTask(taskId);
  if (supervisorId) {
    try {
      supervisorStatus = await getSupervisorStatus(supervisorId);
    } catch {
      // Supervisor may have been deleted
    }
  }

  const childTasks = await taskAccessor.findByParentId(taskId);
  const taskSummary = calculateTaskSummary(childTasks);

  return {
    ...baseData,
    supervisor: supervisorStatus,
    taskSummary,
    tasks: childTasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      assignedAgentId: t.assignedAgentId,
      prUrl: t.prUrl,
    })),
  };
}

/**
 * Build status response for a child task
 */
async function buildChildTaskStatus(task: Task, baseData: Record<string, unknown>) {
  let workerStatus = null;
  let worktreePath: string | null = null;
  if (task.assignedAgentId) {
    try {
      workerStatus = await getWorkerStatus(task.assignedAgentId);
      // Get worktreePath from the assigned agent
      const agent = await agentAccessor.findById(task.assignedAgentId);
      worktreePath = agent?.worktreePath ?? null;
    } catch {
      // Worker may have been deleted
    }
  }

  return {
    ...baseData,
    assignedAgentId: task.assignedAgentId,
    worktreePath,
    branchName: task.branchName,
    prUrl: task.prUrl,
    failureReason: task.failureReason,
    worker: workerStatus,
  };
}

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /api/tasks/list
 * List tasks with optional filters
 */
router.get('/list', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const isTopLevel = req.query.isTopLevel === 'true';
    const state = req.query.state as TaskState | undefined;
    const parentId = req.query.parentId as string | undefined;

    const tasks = await taskAccessor.list({
      projectId,
      isTopLevel: isTopLevel || undefined,
      state,
      parentId,
    });

    return res.status(200).json({
      success: true,
      data: {
        tasks: tasks.map((t) => ({
          id: t.id,
          parentId: t.parentId,
          title: t.title,
          state: t.state,
          assignedAgentId: t.assignedAgentId,
          prUrl: t.prUrl,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      },
    });
  } catch (error) {
    console.error('Error listing tasks:', error);
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
 * POST /api/tasks/create
 * Create a new task (top-level or child)
 */
router.post('/create', async (req, res) => {
  try {
    const validatedInput = CreateTaskSchema.parse(req.body);
    const isTopLevel = validatedInput.parentId === null || validatedInput.parentId === undefined;

    // Resolve project ID
    const projectResult = await resolveProjectId(validatedInput, isTopLevel);
    if ('error' in projectResult) {
      return res.status(projectResult.status).json({
        success: false,
        error: projectResult.error,
      });
    }

    // Create task
    const task = await taskAccessor.create({
      projectId: projectResult.projectId,
      parentId: isTopLevel ? null : validatedInput.parentId,
      title: validatedInput.title,
      description: validatedInput.description,
      state: isTopLevel ? TaskState.PLANNING : TaskState.PENDING,
    });

    // Fire appropriate event
    await fireTaskCreatedEvent(task, isTopLevel, validatedInput.parentId as string | undefined);

    return res.status(201).json({
      success: true,
      data: {
        taskId: task.id,
        parentId: task.parentId,
        title: task.title,
        description: task.description,
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
          details: error.issues,
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
 * GET /api/tasks/status/:taskId
 * Get task status including worker/supervisor info
 * For top-level tasks, includes supervisor status and child task summary
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    const taskId = req.params.taskId;

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

    const isTopLevel = task.parentId === null;
    const baseData: Record<string, unknown> = {
      taskId: task.id,
      parentId: task.parentId,
      title: task.title,
      description: task.description,
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    };

    const responseData = isTopLevel
      ? await buildTopLevelTaskStatus(task, baseData)
      : await buildChildTaskStatus(task, baseData);

    return res.status(200).json({
      success: true,
      data: responseData,
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
 * GET /api/tasks/supervisors
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
 * POST /api/tasks/start-supervisor
 * Start a supervisor for a top-level task
 */
router.post('/start-supervisor', async (req, res) => {
  try {
    const validatedInput = StartSupervisorSchema.parse(req.body);

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

    // Verify it's a top-level task
    if (task.parentId !== null) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NOT_TOP_LEVEL_TASK',
          message: `Task '${validatedInput.taskId}' is not a top-level task`,
        },
      });
    }

    // Check if task already has a supervisor
    const existingSupervisor = await getSupervisorForTask(validatedInput.taskId);
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
    const agentId = await startSupervisorForTask(validatedInput.taskId);

    // Get supervisor details
    const status = await getSupervisorStatus(agentId);

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
 * POST /api/tasks/stop-supervisor
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
 * POST /api/tasks/kill-supervisor
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
 * POST /api/tasks/recreate-supervisor
 * Recreate a supervisor for a top-level task
 */
router.post('/recreate-supervisor', async (req, res) => {
  try {
    const validatedInput = RecreateSupervisorSchema.parse(req.body);

    const agentId = await recreateSupervisor(validatedInput.taskId);
    const status = await getSupervisorStatus(agentId);

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
          details: error.issues,
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
          details: error.issues,
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
          details: error.issues,
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
          details: error.issues,
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
          details: error.issues,
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
