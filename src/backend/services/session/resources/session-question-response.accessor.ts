import { prisma } from '@/backend/db';
import type { QuestionResponse } from '@/shared/acp-protocol/protocol/question-response';

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
