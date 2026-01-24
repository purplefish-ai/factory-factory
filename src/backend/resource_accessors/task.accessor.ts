import type { Prisma, Task, TaskDependency } from '@prisma-gen/client';
import { TaskState } from '@prisma-gen/client';
import { prisma } from '../db.js';

// Type for Task with all relations included
export type TaskWithRelations = Prisma.TaskGetPayload<{
  include: {
    project: true;
    parent: true;
    children: true;
    assignedAgent: true;
    supervisorAgent: true;
    dependsOn: { include: { dependsOn: true } };
    dependents: { include: { task: true } };
  };
}>;

// Lighter type without dependency details
export type TaskWithBasicRelations = Prisma.TaskGetPayload<{
  include: {
    project: true;
    parent: true;
    children: true;
    assignedAgent: true;
    supervisorAgent: true;
  };
}>;

export interface CreateTaskInput {
  projectId: string;
  parentId?: string | null;
  title: string;
  description?: string;
  state?: TaskState;
  linearIssueId?: string;
  linearIssueUrl?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  state?: TaskState;
  assignedAgentId?: string | null;
  worktreePath?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  attempts?: number;
  completedAt?: Date | null;
  failureReason?: string | null;
}

export interface ListTasksFilters {
  projectId?: string;
  parentId?: string | null;
  state?: TaskState;
  assignedAgentId?: string;
  isTopLevel?: boolean;
  limit?: number;
  offset?: number;
}

const fullInclude = {
  project: true,
  parent: true,
  children: true,
  assignedAgent: true,
  supervisorAgent: true,
  dependsOn: { include: { dependsOn: true } },
  dependents: { include: { task: true } },
} as const;

const basicInclude = {
  project: true,
  parent: true,
  children: true,
  assignedAgent: true,
  supervisorAgent: true,
} as const;

export class TaskAccessor {
  // ============================================
  // Basic CRUD Operations
  // ============================================

  create(data: CreateTaskInput): Promise<TaskWithRelations> {
    // Default state based on whether this is a top-level or leaf task
    const defaultState = data.parentId ? TaskState.PENDING : TaskState.PLANNING;

    return prisma.task.create({
      data: {
        projectId: data.projectId,
        parentId: data.parentId ?? null,
        title: data.title,
        description: data.description,
        state: data.state ?? defaultState,
        linearIssueId: data.linearIssueId,
        linearIssueUrl: data.linearIssueUrl,
      },
      include: fullInclude,
    });
  }

  findById(id: string): Promise<TaskWithRelations | null> {
    return prisma.task.findUnique({
      where: { id },
      include: fullInclude,
    });
  }

  findByLinearIssueId(linearIssueId: string): Promise<TaskWithRelations | null> {
    return prisma.task.findUnique({
      where: { linearIssueId },
      include: fullInclude,
    });
  }

  update(id: string, data: UpdateTaskInput): Promise<Task> {
    return prisma.task.update({
      where: { id },
      data,
    });
  }

  delete(id: string): Promise<Task> {
    return prisma.task.delete({
      where: { id },
    });
  }

  // ============================================
  // Listing Operations
  // ============================================

  list(filters?: ListTasksFilters): Promise<TaskWithBasicRelations[]> {
    const where: Prisma.TaskWhereInput = {};

    if (filters?.projectId) {
      where.projectId = filters.projectId;
    }

    // Handle parentId filter (including explicit null for top-level)
    if (filters?.parentId !== undefined) {
      where.parentId = filters.parentId;
    }

    // Convenience filter for top-level tasks
    if (filters?.isTopLevel) {
      where.parentId = null;
    }

    if (filters?.state) {
      where.state = filters.state;
    }

    if (filters?.assignedAgentId) {
      where.assignedAgentId = filters.assignedAgentId;
    }

    return prisma.task.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { createdAt: 'desc' },
      include: basicInclude,
    });
  }

  /**
   * Find all top-level tasks (tasks without a parent, formerly "Epics")
   */
  findTopLevel(projectId?: string): Promise<TaskWithRelations[]> {
    const where: Prisma.TaskWhereInput = { parentId: null };

    if (projectId) {
      where.projectId = projectId;
    }

    return prisma.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: fullInclude,
    });
  }

  /**
   * Find direct children of a task (formerly "findByEpicId" for top-level tasks)
   */
  findByParentId(parentId: string): Promise<TaskWithBasicRelations[]> {
    return prisma.task.findMany({
      where: { parentId },
      orderBy: { createdAt: 'asc' },
      include: basicInclude,
    });
  }

  // ============================================
  // Hierarchy Helpers
  // ============================================

  /**
   * Get all ancestors of a task up to the root (top-level) task
   */
  async getAncestors(taskId: string): Promise<Task[]> {
    const ancestors: Task[] = [];
    let currentTask = await prisma.task.findUnique({
      where: { id: taskId },
    });

    while (currentTask?.parentId) {
      const parent = await prisma.task.findUnique({
        where: { id: currentTask.parentId },
      });
      if (parent) {
        ancestors.push(parent);
        currentTask = parent;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get all descendants of a task recursively
   */
  async getDescendants(taskId: string): Promise<Task[]> {
    const descendants: Task[] = [];

    const collectDescendants = async (parentId: string) => {
      const children = await prisma.task.findMany({
        where: { parentId },
      });

      for (const child of children) {
        descendants.push(child);
        await collectDescendants(child.id);
      }
    };

    await collectDescendants(taskId);
    return descendants;
  }

  /**
   * Get the top-level parent (root) of a task
   */
  async getTopLevelParent(taskId: string): Promise<Task | null> {
    let currentTask = await prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!currentTask) {
      return null;
    }

    // If already top-level, return itself
    if (!currentTask.parentId) {
      return currentTask;
    }

    // Traverse up to find root
    while (currentTask?.parentId) {
      const parent: Task | null = await prisma.task.findUnique({
        where: { id: currentTask.parentId },
      });
      if (parent) {
        currentTask = parent;
      } else {
        break;
      }
    }

    return currentTask;
  }

  /**
   * Check if a task is a leaf task (has no children)
   */
  async isLeafTask(taskId: string): Promise<boolean> {
    const childCount = await prisma.task.count({
      where: { parentId: taskId },
    });
    return childCount === 0;
  }

  /**
   * Check if a task is a top-level task (has no parent)
   */
  async isTopLevelTask(taskId: string): Promise<boolean> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    return task?.parentId === null;
  }

  // ============================================
  // Dependency Helpers
  // ============================================

  /**
   * Add a dependency between tasks (taskId depends on dependsOnId)
   */
  addDependency(taskId: string, dependsOnId: string): Promise<TaskDependency> {
    return prisma.taskDependency.create({
      data: {
        taskId,
        dependsOnId,
      },
    });
  }

  /**
   * Remove a dependency between tasks
   */
  async removeDependency(taskId: string, dependsOnId: string): Promise<void> {
    await prisma.taskDependency.delete({
      where: {
        taskId_dependsOnId: { taskId, dependsOnId },
      },
    });
  }

  /**
   * Get all tasks that this task depends on
   */
  async getDependencies(taskId: string): Promise<Task[]> {
    const dependencies = await prisma.taskDependency.findMany({
      where: { taskId },
      include: { dependsOn: true },
    });
    return dependencies.map((d) => d.dependsOn);
  }

  /**
   * Get all tasks that depend on this task
   */
  async getDependents(taskId: string): Promise<Task[]> {
    const dependents = await prisma.taskDependency.findMany({
      where: { dependsOnId: taskId },
      include: { task: true },
    });
    return dependents.map((d) => d.task);
  }

  /**
   * Get incomplete dependencies (tasks that block this task)
   */
  async getBlockedBy(taskId: string): Promise<Task[]> {
    const dependencies = await prisma.taskDependency.findMany({
      where: { taskId },
      include: { dependsOn: true },
    });

    return dependencies
      .filter((d) => d.dependsOn.state !== TaskState.COMPLETED)
      .map((d) => d.dependsOn);
  }

  /**
   * Check if a task is blocked by incomplete dependencies
   */
  async isBlocked(taskId: string): Promise<boolean> {
    const blockedBy = await this.getBlockedBy(taskId);
    return blockedBy.length > 0;
  }

  /**
   * Detect if adding a dependency would create a cycle
   */
  async wouldCreateCycle(taskId: string, dependsOnId: string): Promise<boolean> {
    // Check if dependsOnId already depends on taskId (directly or indirectly)
    const visited = new Set<string>();

    const hasCycle = async (currentId: string): Promise<boolean> => {
      if (currentId === taskId) {
        return true;
      }
      if (visited.has(currentId)) {
        return false;
      }

      visited.add(currentId);

      const deps = await prisma.taskDependency.findMany({
        where: { taskId: currentId },
        select: { dependsOnId: true },
      });

      for (const dep of deps) {
        if (await hasCycle(dep.dependsOnId)) {
          return true;
        }
      }

      return false;
    };

    return await hasCycle(dependsOnId);
  }

  // ============================================
  // State & Queue Helpers
  // ============================================

  /**
   * Get tasks that are ready to start (PENDING with no incomplete dependencies)
   */
  async getReadyTasks(parentId: string): Promise<Task[]> {
    const pendingTasks = await prisma.task.findMany({
      where: {
        parentId,
        state: TaskState.PENDING,
      },
    });

    const readyTasks: Task[] = [];

    for (const task of pendingTasks) {
      const isBlocked = await this.isBlocked(task.id);
      if (!isBlocked) {
        readyTasks.push(task);
      }
    }

    return readyTasks;
  }

  /**
   * Get tasks in REVIEW state, ordered by submission time
   */
  getReviewQueue(parentId: string): Promise<Task[]> {
    return prisma.task.findMany({
      where: {
        parentId,
        state: TaskState.REVIEW,
      },
      orderBy: { updatedAt: 'asc' },
      include: {
        assignedAgent: true,
      },
    });
  }

  /**
   * Check if all children of a task are in a terminal state
   */
  async areAllChildrenComplete(taskId: string): Promise<boolean> {
    const incompleteCount = await prisma.task.count({
      where: {
        parentId: taskId,
        state: {
          notIn: [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED],
        },
      },
    });
    return incompleteCount === 0;
  }

  /**
   * Count children by state
   */
  async getChildrenStateCounts(taskId: string): Promise<Record<TaskState, number>> {
    const children = await prisma.task.findMany({
      where: { parentId: taskId },
      select: { state: true },
    });

    const counts: Record<TaskState, number> = {
      [TaskState.PLANNING]: 0,
      [TaskState.PLANNED]: 0,
      [TaskState.PENDING]: 0,
      [TaskState.ASSIGNED]: 0,
      [TaskState.IN_PROGRESS]: 0,
      [TaskState.REVIEW]: 0,
      [TaskState.COMPLETED]: 0,
      [TaskState.BLOCKED]: 0,
      [TaskState.FAILED]: 0,
      [TaskState.CANCELLED]: 0,
    };

    for (const child of children) {
      counts[child.state]++;
    }

    return counts;
  }
}

export const taskAccessor = new TaskAccessor();
