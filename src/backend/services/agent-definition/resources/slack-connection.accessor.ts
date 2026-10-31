import { prisma } from '@/backend/db';

export const slackConnectionAccessor = {
  list() {
    return prisma.agentConnection.findMany({
      where: { provider: 'SLACK' },
      orderBy: { createdAt: 'asc' },
    });
  },
  get(id: string) {
    return prisma.agentConnection.findFirst({ where: { id, provider: 'SLACK' } });
  },
  save(workspaceId: string, name: string, credentialsEncrypted: string) {
    return prisma.agentConnection.upsert({
      where: { provider_externalId: { provider: 'SLACK', externalId: workspaceId } },
      create: { provider: 'SLACK', externalId: workspaceId, name, credentialsEncrypted },
      update: { name, credentialsEncrypted, isEnabled: true },
    });
  },
  disconnect(id: string) {
    return prisma.agentConnection.updateMany({
      where: { id, provider: 'SLACK' },
      data: { credentialsEncrypted: null, isEnabled: false },
    });
  },
};
