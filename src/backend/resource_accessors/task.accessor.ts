import type { Prisma, Task } from '@prisma-gen/client';
import { TaskState } from '@prisma-gen/client';
import { prisma } from '../db';

export interface CreateTaskInput {
  epicId: string;
  title: string;
  description?: string;
  state?: TaskState;
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
  epicId?: string;
  state?: TaskState;
  assignedAgentId?: string;
  limit?: number;
  offset?: number;
}

export class TaskAccessor {
  async create(data: CreateTaskInput): Promise<Task> {
    return prisma.task.create({
      data: {
        epicId: data.epicId,
        title: data.title,
        description: data.description,
        state: data.state ?? TaskState.PENDING,
      },
    });
  }

  async findById(id: string): Promise<Task | null> {
    return prisma.task.findUnique({
      where: { id },
      include: {
        epic: {
          include: {
            project: true,
          },
        },
        assignedAgent: true,
      },
    });
  }

  async update(id: string, data: UpdateTaskInput): Promise<Task> {
    return prisma.task.update({
      where: { id },
      data,
    });
  }

  async list(filters?: ListTasksFilters): Promise<Task[]> {
    const where: Prisma.TaskWhereInput = {};

    if (filters?.projectId) {
      where.epic = { projectId: filters.projectId };
    }
    if (filters?.epicId) {
      where.epicId = filters.epicId;
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
      include: {
        epic: true,
        assignedAgent: true,
      },
    });
  }

  async findByEpicId(epicId: string): Promise<Task[]> {
    return prisma.task.findMany({
      where: { epicId },
      orderBy: { createdAt: 'asc' },
      include: {
        assignedAgent: true,
      },
    });
  }

  async delete(id: string): Promise<Task> {
    return prisma.task.delete({
      where: { id },
    });
  }
}

export const taskAccessor = new TaskAccessor();
