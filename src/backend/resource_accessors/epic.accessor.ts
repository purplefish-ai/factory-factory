import { prisma } from '../db';
import type { Epic, Prisma } from '@prisma/client';
import { EpicState } from '@prisma/client';

export interface CreateEpicInput {
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
  state?: EpicState;
  limit?: number;
  offset?: number;
}

export class EpicAccessor {
  async create(data: CreateEpicInput): Promise<Epic> {
    return prisma.epic.create({
      data: {
        linearIssueId: data.linearIssueId,
        linearIssueUrl: data.linearIssueUrl,
        title: data.title,
        description: data.description,
        state: data.state ?? EpicState.PLANNING,
      },
    });
  }

  async findById(id: string): Promise<Epic | null> {
    return prisma.epic.findUnique({
      where: { id },
      include: {
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  async findByLinearIssueId(linearIssueId: string): Promise<Epic | null> {
    return prisma.epic.findUnique({
      where: { linearIssueId },
      include: {
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  async update(id: string, data: UpdateEpicInput): Promise<Epic> {
    return prisma.epic.update({
      where: { id },
      data,
    });
  }

  async list(filters?: ListEpicsFilters): Promise<Epic[]> {
    const where: Prisma.EpicWhereInput = {};

    if (filters?.state) {
      where.state = filters.state;
    }

    return prisma.epic.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { createdAt: 'desc' },
      include: {
        tasks: true,
        orchestratorAgent: true,
      },
    });
  }

  async delete(id: string): Promise<Epic> {
    return prisma.epic.delete({
      where: { id },
    });
  }
}

export const epicAccessor = new EpicAccessor();
