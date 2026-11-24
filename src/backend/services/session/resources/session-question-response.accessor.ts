import { prisma } from '@/backend/db';
import type { QuestionResponse } from '@/shared/acp-protocol/protocol/question-response';
import type { Prisma } from '@prisma-gen/client';

type QuestionResponseClient = Pick<Prisma.TransactionClient, 'sessionQuestionResponse'>;

export function readSessionQuestionResponsesForBackup(tx: QuestionResponseClient) {
  return tx.sessionQuestionResponse.findMany({
    orderBy: [{ sessionId: 'asc' }, { providerSessionId: 'asc' }, { toolUseId: 'asc' }],
  });
}

export async function createImportedSessionQuestionResponses(
  tx: QuestionResponseClient,
  rows: Prisma.SessionQuestionResponseCreateManyInput[]
): Promise<void> {
  await tx.sessionQuestionResponse.createMany({ data: rows });
}

export const sessionQuestionResponseAccessor = {
  async upsert(
    sessionId: string,
    providerSessionId: string,
    timestamp: Date,
    summary: QuestionResponse
  ): Promise<void> {
    const { toolUseId } = summary;
    await prisma.sessionQuestionResponse.upsert({
      where: { sessionId_providerSessionId_toolUseId: { sessionId, providerSessionId, toolUseId } },
      create: { sessionId, providerSessionId, toolUseId, timestamp, summary },
      update: { summary },
    });
  },

  findBySessionId(sessionId: string, providerSessionId: string) {
    return prisma.sessionQuestionResponse.findMany({
      where: { sessionId, providerSessionId },
      orderBy: [{ timestamp: 'asc' }, { toolUseId: 'asc' }],
    });
  },
};
