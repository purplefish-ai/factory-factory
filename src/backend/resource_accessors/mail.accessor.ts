import type { Mail, Prisma } from '@prisma-gen/client';
import { prisma } from '../db';

export interface CreateMailInput {
  fromAgentId?: string;
  toAgentId?: string;
  isForHuman?: boolean;
  subject: string;
  body: string;
}

export interface UpdateMailInput {
  isRead?: boolean;
  readAt?: Date | null;
}

export class MailAccessor {
  create(data: CreateMailInput): Promise<Mail> {
    return prisma.mail.create({
      data: {
        fromAgentId: data.fromAgentId,
        toAgentId: data.toAgentId,
        isForHuman: data.isForHuman ?? false,
        subject: data.subject,
        body: data.body,
      },
    });
  }

  findById(id: string): Promise<Mail | null> {
    return prisma.mail.findUnique({
      where: { id },
      include: {
        fromAgent: true,
        toAgent: true,
      },
    });
  }

  update(id: string, data: UpdateMailInput): Promise<Mail> {
    const updateData: Prisma.MailUpdateInput = {
      isRead: data.isRead,
    };

    if (data.isRead === true && !data.readAt) {
      updateData.readAt = new Date();
    } else if (data.readAt !== undefined) {
      updateData.readAt = data.readAt;
    }

    return prisma.mail.update({
      where: { id },
      data: updateData,
    });
  }

  listInbox(agentId: string, includeRead = false): Promise<Mail[]> {
    const where: Prisma.MailWhereInput = {
      toAgentId: agentId,
    };

    if (!includeRead) {
      where.isRead = false;
    }

    return prisma.mail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        fromAgent: true,
        toAgent: true,
      },
    });
  }

  listHumanInbox(includeRead = false, projectId?: string): Promise<Mail[]> {
    const where: Prisma.MailWhereInput = {
      isForHuman: true,
    };

    if (!includeRead) {
      where.isRead = false;
    }

    // Filter by project via fromAgent → currentEpic → projectId
    if (projectId) {
      where.fromAgent = {
        currentEpic: {
          projectId,
        },
      };
    }

    return prisma.mail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        fromAgent: true,
        toAgent: true,
      },
    });
  }

  listAll(includeRead = true, projectId?: string): Promise<Mail[]> {
    const where: Prisma.MailWhereInput = {};

    if (!includeRead) {
      where.isRead = false;
    }

    // Filter by project via agent → currentEpic → projectId
    if (projectId) {
      where.OR = [
        {
          fromAgent: {
            currentEpic: {
              projectId,
            },
          },
        },
        {
          toAgent: {
            currentEpic: {
              projectId,
            },
          },
        },
      ];
    }

    return prisma.mail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        fromAgent: true,
        toAgent: true,
      },
    });
  }

  markAsRead(id: string): Promise<Mail> {
    return this.update(id, { isRead: true });
  }

  delete(id: string): Promise<Mail> {
    return prisma.mail.delete({
      where: { id },
    });
  }
}

export const mailAccessor = new MailAccessor();
