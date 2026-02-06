import type { RatchetAuditLog, RatchetState } from '@prisma-gen/client';
import { prisma } from '../db';

interface CreateRatchetAuditLogInput {
  workspaceId: string;
  prNumber?: number;
  previousState: RatchetState;
  newState: RatchetState;
  action: string;
  actionDetail?: string;
  prSnapshot?: string;
}

class RatchetAuditLogAccessor {
  create(data: CreateRatchetAuditLogInput): Promise<RatchetAuditLog> {
    return prisma.ratchetAuditLog.create({ data });
  }

  findByWorkspaceId(workspaceId: string, limit = 100): Promise<RatchetAuditLog[]> {
    return prisma.ratchetAuditLog.findMany({
      where: { workspaceId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  findRecent(limit = 100): Promise<RatchetAuditLog[]> {
    return prisma.ratchetAuditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}

export const ratchetAuditLogAccessor = new RatchetAuditLogAccessor();
