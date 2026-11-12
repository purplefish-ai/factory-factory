import { z } from 'zod';
import { prisma } from '@/backend/db';
import { slackConnectionSummarySchema } from '@/shared/slack-connection';
import { Prisma } from '@prisma-gen/client';

const sqliteBoolean = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal(0n), z.literal(1n)])
  .transform(Boolean);
const summariesSchema = z.array(
  slackConnectionSummarySchema.extend({
    isEnabled: sqliteBoolean,
    hasCredentials: sqliteBoolean,
    hasAppToken: sqliteBoolean,
  })
);

// Compute credential presence in SQLite so summary reads never load ciphertext.
async function summaries(id?: string) {
  const rows = await prisma.$queryRaw<unknown>`
    SELECT "id", "name", "externalId" AS "workspaceId", "isEnabled",
      ("credentialsEncrypted" IS NOT NULL AND "credentialsEncrypted" <> '') AS "hasCredentials",
      ("appCredentialsEncrypted" IS NOT NULL AND "appCredentialsEncrypted" <> '') AS "hasAppToken",
      "appId"
    FROM "AgentConnection"
    WHERE "provider" = 'SLACK' ${id === undefined ? Prisma.empty : Prisma.sql`AND "id" = ${id}`}
    ORDER BY "createdAt" ASC
  `;
  return summariesSchema.parse(rows);
}
async function summary(id: string) {
  return (await summaries(id))[0] ?? null;
}

export const slackConnectionAccessor = {
  list() {
    return summaries();
  },
  summary,
  get(id: string) {
    return prisma.agentConnection.findFirst({ where: { id, provider: 'SLACK' } });
  },
  async save(workspaceId: string, name: string, credentialsEncrypted: string) {
    const connection = await prisma.agentConnection.upsert({
      where: { provider_externalId: { provider: 'SLACK', externalId: workspaceId } },
      create: { provider: 'SLACK', externalId: workspaceId, name, credentialsEncrypted },
      update: { name, credentialsEncrypted, isEnabled: true },
      select: { id: true },
    });
    const saved = await summary(connection.id);
    if (!saved) {
      throw new Error('Saved Slack connection is missing');
    }
    return saved;
  },
  /**
   * Stores the app-level token only if the bot credential it was validated
   * against is still the saved, enabled one.
   */
  async saveAppCredentials(input: {
    id: string;
    validatedBotCredentials: string;
    appCredentialsEncrypted: string;
    appId: string;
  }) {
    const result = await prisma.agentConnection.updateMany({
      where: {
        id: input.id,
        provider: 'SLACK',
        isEnabled: true,
        credentialsEncrypted: input.validatedBotCredentials,
      },
      data: { appCredentialsEncrypted: input.appCredentialsEncrypted, appId: input.appId },
    });
    return result.count ? summary(input.id) : null;
  },
  async clearAppCredentials(id: string) {
    const result = await prisma.agentConnection.updateMany({
      where: { id, provider: 'SLACK' },
      data: { appCredentialsEncrypted: null, appId: null },
    });
    return result.count ? summary(id) : null;
  },
  disconnect(id: string) {
    return prisma.agentConnection.updateMany({
      where: { id, provider: 'SLACK' },
      data: {
        credentialsEncrypted: null,
        appCredentialsEncrypted: null,
        appId: null,
        isEnabled: false,
      },
    });
  },
};
