import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { SERVICE_LIMITS } from '@/backend/services/constants';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { submittedIntentSchema as submittedSchema } from '@/shared/schemas/chat-intent.schema';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { ChatSettingsSchema } from '@/shared/websocket/chat-message.schema';
import { Prisma } from '@prisma-gen/client';
import type { PrismaClient, ChatIntent } from '@prisma-gen/client';

const dispatchMembersSchema = z.array(
  z.object({ messageId: z.string(), owner: z.enum(['human', 'external']), message: z.json() })
);
const statusSchema = z.enum(['queued', 'uncertain', 'committed', 'cancelled', 'failed']);
export type IntentRecord = {
  message: QueuedMessage;
  status: z.infer<typeof statusSchema>;
  attemptId?: string;
  revision: number;
};
export class ChatIntentConflictError extends Error {
  constructor() {
    super('Message id already accepted with different submitted content');
  }
}
export class ChatIntentRevisionChangedError extends Error {
  constructor() {
    super('Queued desired settings changed before the prompt was frozen');
  }
}

export class ChatIntentQueueFullError extends Error {
  constructor() {
    super(`Queue full (max ${SERVICE_LIMITS.sessionStoreMaxQueueSize} messages)`);
  }
}
function decode(row: ChatIntent): IntentRecord {
  const message = submittedSchema.parse(row.submitted);
  message.settings = ChatSettingsSchema.parse(row.desired);
  return {
    message,
    revision: row.revision,
    status: statusSchema.parse(row.status),
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
  };
}
function fingerprint(message: QueuedMessage): string {
  const value = submittedSchema.parse(message);
  // Schema field order canonicalizes object keys. Acceptance time is not submitted intent.
  return createHash('sha256')
    .update(JSON.stringify({ ...value, timestamp: undefined }))
    .digest('hex');
}

/** Sole writer for accepted humans and their aggregate provider effects. */
export class ChatIntentAccessor {
  constructor(private readonly client: PrismaClient | (() => PrismaClient)) {}
  private get db(): PrismaClient {
    return typeof this.client === 'function' ? this.client() : this.client;
  }

  accept(
    sessionId: string,
    message: QueuedMessage,
    full: boolean
  ): Promise<IntentRecord & { created: boolean }> {
    const hash = fingerprint(message);
    return this.db.$transaction(async (tx) => {
      const where = { sessionId_messageId: { sessionId, messageId: message.id } };
      const prior = await tx.chatIntent.findUnique({ where });
      if (prior) {
        if (prior.fingerprint !== hash) {
          throw new ChatIntentConflictError();
        }
        return { ...decode(prior), created: false };
      }
      const count = await tx.chatIntent.count({ where: { sessionId, status: 'queued' } });
      if (full || count >= SERVICE_LIMITS.sessionStoreMaxQueueSize) {
        throw new ChatIntentQueueFullError();
      }
      const row = await tx.chatIntent.create({
        data: {
          sessionId,
          messageId: message.id,
          fingerprint: hash,
          submitted: submittedSchema.parse(message),
          desired: message.settings,
        },
      });
      return { ...decode(row), created: true };
    });
  }

  async hasUncertainAttempt(sessionId: string): Promise<boolean> {
    return (
      (await this.db.promptDispatchAttempt.count({ where: { sessionId, status: 'uncertain' } })) > 0
    );
  }

  async find(sessionId: string, messageId: string): Promise<IntentRecord | undefined> {
    const row = await this.db.chatIntent.findUnique({
      where: { sessionId_messageId: { sessionId, messageId } },
    });
    return row ? decode(row) : undefined;
  }

  async read(sessionId: string, recoverableOnly = false): Promise<IntentRecord[]> {
    return (
      await this.db.chatIntent.findMany({
        where: {
          sessionId,
          ...(recoverableOnly ? { status: { in: ['queued', 'uncertain', 'failed'] } } : {}),
        },
        orderBy: { id: 'asc' },
      })
    ).map(decode);
  }

  async override(
    sessionId: string,
    requestedAt: number,
    settings: Partial<QueuedMessage['settings']>
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const rows = await tx.chatIntent.findMany({ where: { sessionId, status: 'queued' } });
      for (const row of rows) {
        const current = decode(row).message;
        if (Date.parse(current.timestamp) <= requestedAt) {
          await tx.chatIntent.update({
            where: { id: row.id },
            data: { desired: { ...current.settings, ...settings }, revision: { increment: 1 } },
          });
        }
      }
    });
  }

  claim(
    sessionId: string,
    messages: readonly QueuedMessage[],
    content: string | AgentContentItem[],
    settings: QueuedMessage['settings'],
    generation: number,
    expectedRevisions?: Record<string, number>,
    expectedProvider?: { provider: string; providerSessionId: string; configOptions: unknown }
  ): Promise<string | null> {
    return this.db.$transaction(async (tx) => {
      const ids = messages.map((m) => m.id);
      const rows = await tx.chatIntent.findMany({ where: { sessionId, messageId: { in: ids } } });
      // Legacy/external-only deliveries keep their existing replay owner.
      if (!rows.length) {
        return null;
      }
      if (rows.some((r) => r.status !== 'queued')) {
        throw new Error('Human dispatch members are no longer queued');
      }
      if (
        expectedRevisions &&
        rows.some((row) => expectedRevisions[row.messageId] !== row.revision)
      ) {
        throw new ChatIntentRevisionChangedError();
      }
      const session = await tx.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      if (
        expectedProvider &&
        (session.provider !== expectedProvider.provider ||
          session.providerSessionId !== expectedProvider.providerSessionId)
      ) {
        throw new ChatIntentRevisionChangedError();
      }
      const attempt = await tx.promptDispatchAttempt.create({
        data: {
          sessionId,
          members: messages.map((message) => {
            const row = rows.find((entry) => entry.messageId === message.id);
            return {
              messageId: message.id,
              owner: row ? 'human' : 'external',
              ...(row ? { revision: row.revision } : {}),
              message: z.json().parse(JSON.parse(JSON.stringify(message))),
            };
          }),
          content: z.union([z.string(), z.array(z.json())]).parse(content),
          effectiveSettings: settings,
          providerIdentity: {
            provider: session.provider,
            providerSessionId: session.providerSessionId,
            codexAccountId: session.codexAccountId,
            ...(expectedProvider
              ? {
                  nativeConfigOptions: z
                    .array(z.json())
                    .parse(JSON.parse(JSON.stringify(expectedProvider.configOptions))),
                }
              : {}),
          },
          sendGeneration: generation,
        },
      });
      const claimed = await tx.chatIntent.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'queued' },
        data: { status: 'uncertain', attemptId: attempt.id },
      });
      if (claimed.count !== rows.length) {
        throw new Error('Incomplete human dispatch claim');
      }
      return attempt.id;
    });
  }

  async settle(
    attemptId: string,
    status: 'committed' | 'cancelled' | 'queued',
    evidence = 'provider prompt completed'
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const settled = await tx.promptDispatchAttempt.updateMany({
        where: { id: attemptId, status: 'uncertain' },
        data: { status, evidence, settledAt: new Date() },
      });
      if (settled.count) {
        await tx.chatIntent.updateMany({
          where: { attemptId, status: 'uncertain' },
          data: { status, ...(status === 'queued' ? { attemptId: null } : {}) },
        });
      }
    });
  }

  async listUncertain(sessionId: string) {
    const rows = await this.db.promptDispatchAttempt.findMany({
      where: { sessionId, status: 'uncertain' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      members: dispatchMembersSchema
        .parse(row.members)
        .map(({ messageId, owner }) => ({ id: messageId, owner })),
      providerIdentity: z.json().parse(row.providerIdentity),
      effectiveSettings: ChatSettingsSchema.parse(row.effectiveSettings),
    }));
  }

  async resolve(
    sessionId: string,
    attemptId: string,
    status: 'committed' | 'cancelled'
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const attempt = await tx.promptDispatchAttempt.findFirstOrThrow({
        where: { id: attemptId, sessionId, status: 'uncertain' },
      });
      const members = dispatchMembersSchema.parse(attempt.members);
      if (members.some((member) => member.owner !== 'human')) {
        throw new Error(
          'Mixed dispatch recovery requires the external delivery owner; this whole batch remains held'
        );
      }
      const rows = await tx.chatIntent.findMany({
        where: { attemptId, status: 'uncertain' },
        select: { messageId: true },
      });
      if (
        rows.length !== members.length ||
        !members.every((member) => rows.some((row) => row.messageId === member.messageId))
      ) {
        throw new Error('Incomplete dispatch membership; recovery refused');
      }
      await tx.promptDispatchAttempt.update({
        where: { id: attemptId },
        data: {
          status,
          settledAt: new Date(),
          evidence:
            status === 'committed'
              ? 'user confirmed full batch delivered after checking provider history'
              : 'user dismissed full batch without replay',
        },
      });
      await tx.chatIntent.updateMany({
        where: { attemptId, status: 'uncertain' },
        data: { status },
      });
    });
  }

  async cancel(
    sessionId: string,
    messageId?: string,
    status: 'cancelled' | 'failed' = 'cancelled'
  ): Promise<void> {
    await this.db.chatIntent.updateMany({
      where: { sessionId, ...(messageId ? { messageId } : {}), status: 'queued' },
      data: { status },
    });
  }
}

export const chatIntentAccessor = new ChatIntentAccessor(() => prisma);

export function validateRecoveryChatIntentFingerprints(data: DurableRecovery): void {
  for (const row of data.chatIntent) {
    if (fingerprint(submittedSchema.parse(row.submitted)) !== row.fingerprint) {
      throw new ApplicationError(
        'INVALID_INPUT',
        `Imported chat intent fingerprint disagrees with submitted content: ${row.messageId}`
      );
    }
  }
}

/** Additive recovery preserves whole provider effects, never borrows local members. */
export async function restoreRecoveryChatIntents(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  sessions: ReadonlySet<string>
) {
  validateRecoveryChatIntentFingerprints(data);
  const attempts = await restoreRecoveryAttempts(tx, data, sessions);
  for (const row of [...data.chatIntent].sort((a, b) => a.id - b.id)) {
    if (
      !sessions.has(row.sessionId) ||
      (row.attemptId && !attempts.has(row.attemptId)) ||
      (await tx.chatIntent.findFirst({
        where: { sessionId: row.sessionId, messageId: row.messageId },
      }))
    ) {
      continue;
    }
    const { id: _sourceOrderingId, ...intent } = row;
    await tx.chatIntent.create({
      data: {
        ...intent,
        status: row.status === 'queued' ? 'failed' : row.status,
        submitted: row.submitted ?? Prisma.JsonNull,
        desired: row.desired ?? Prisma.JsonNull,
      },
    });
  }
}

async function restoreRecoveryAttempts(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  sessions: ReadonlySet<string>
) {
  const attempts = new Set<string>();
  const rejected = new Set<string>();
  for (const intent of data.chatIntent) {
    if (
      await tx.chatIntent.findFirst({
        where: {
          sessionId: intent.sessionId,
          messageId: intent.messageId,
        },
      })
    ) {
      if (intent.attemptId) {
        rejected.add(intent.attemptId);
      }
    }
  }
  for (const row of data.promptDispatchAttempt) {
    if (
      !sessions.has(row.sessionId) ||
      rejected.has(row.id) ||
      (await tx.promptDispatchAttempt.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.promptDispatchAttempt.create({
      data: {
        ...row,
        status: row.status === 'queued' ? 'cancelled' : row.status,
        members: row.members,
        content: row.content ?? Prisma.JsonNull,
        effectiveSettings: row.effectiveSettings ?? Prisma.JsonNull,
        providerIdentity: row.providerIdentity ?? Prisma.JsonNull,
      },
    });
    attempts.add(row.id);
  }
  return attempts;
}
