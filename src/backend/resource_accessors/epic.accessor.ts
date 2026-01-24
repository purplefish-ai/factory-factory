import type { Epic, Prisma } from '@prisma-gen/client';
import { EpicState } from '@prisma-gen/client';
import { prisma } from '../db';

// Type for Epic with all relations included
export type EpicWithRelations = Prisma.EpicGetPayload<{
  include: { project: true; tasks: true; orchestratorAgent: true };
}>;

export interface CreateEpicInput {
  projectId: string;
  linearIssueId: string;
  linearIssueUrl: string;
  title: string;
  description?: string;
  state?: EpicState;
}

export interface UpdateEpicInput {
  title?: string;
  description?: string;
  state?: EpicState;
  completedAt?: Date | null;
}

export interface ListEpicsFilters {
  projectId?: string;
  state?: EpicState;
  limit?: number;
  offset?: number;
}

export class EpicAccessor {
  create(data: CreateEpicInput): Promise<EpicWithRelations> {
    return prisma.epic.create({
      data: {
        projectId: data.projectId,
        linearIssueId: data.linearIssueId,
        linearIssueUrl: data.linearIssueUrl,
        title: data.title,
        description: data.description,
        state: data.state ?? EpicState.PLANNING,
      },
      include: {
        project: true,
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  findById(id: string): Promise<EpicWithRelations | null> {
    return prisma.epic.findUnique({
      where: { id },
      include: {
        project: true,
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  findByLinearIssueId(linearIssueId: string): Promise<EpicWithRelations | null> {
    return prisma.epic.findUnique({
      where: { linearIssueId },
      include: {
        project: true,
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  update(id: string, data: UpdateEpicInput): Promise<Epic> {
    return prisma.epic.update({
      where: { id },
      data,
    });
  }

  list(filters?: ListEpicsFilters): Promise<EpicWithRelations[]> {
    const where: Prisma.EpicWhereInput = {};

    if (filters?.projectId) {
      where.projectId = filters.projectId;
    }

    if (filters?.state) {
      where.state = filters.state;
    }

    return prisma.epic.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { createdAt: 'desc' },
      include: {
        project: true,
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  delete(id: string): Promise<Epic> {
    return prisma.epic.delete({
      where: { id },
    });
  }
}

export const epicAccessor = new EpicAccessor();
