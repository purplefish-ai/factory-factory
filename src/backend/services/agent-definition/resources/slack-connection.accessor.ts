import { z } from 'zod';
import { prisma } from '@/backend/db';
import { slackConnectionSummarySchema } from '@/shared/slack-connection';

const sqliteBoolean = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal(0n), z.literal(1n)])
  .transform(Boolean);
const summariesSchema = z.array(
  slackConnectionSummarySchema.extend({
    isEnabled: sqliteBoolean,
    hasCredentials: sqliteBoolean,
  })
);
const metadataSelect = { id: true, name: true, externalId: true, isEnabled: true } as const;

export const slackConnectionAccessor = {
  async list() {
    // Compute credential presence in SQLite so list reads never load ciphertext.
    const rows = await prisma.$queryRaw<unknown>`
      SELECT "id", "name", "externalId" AS "workspaceId", "isEnabled",
        ("credentialsEncrypted" IS NOT NULL AND "credentialsEncrypted" <> '') AS "hasCredentials"
      FROM "AgentConnection" WHERE "provider" = 'SLACK' ORDER BY "createdAt" ASC
    `;
    return summariesSchema.parse(rows);
  },
  get(id: string) {
    return prisma.agentConnection.findFirst({ where: { id, provider: 'SLACK' } });
  },
  async save(workspaceId: string, name: string, credentialsEncrypted: string) {
    const connection = await prisma.agentConnection.upsert({
      where: { provider_externalId: { provider: 'SLACK', externalId: workspaceId } },
      create: { provider: 'SLACK', externalId: workspaceId, name, credentialsEncrypted },
      update: { name, credentialsEncrypted, isEnabled: true },
      select: metadataSelect,
    });
    return {
      id: connection.id,
      name: connection.name,
      workspaceId: connection.externalId,
      isEnabled: connection.isEnabled,
      hasCredentials: true,
    };
  },
  disconnect(id: string) {
    return prisma.agentConnection.updateMany({
      where: { id, provider: 'SLACK' },
      data: { credentialsEncrypted: null, isEnabled: false },
    });
  },
};
