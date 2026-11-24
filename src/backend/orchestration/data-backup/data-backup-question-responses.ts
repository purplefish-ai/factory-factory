import {
  createImportedSessionQuestionResponses,
  readSessionQuestionResponsesForBackup,
} from '@/backend/services/session';
import {
  QuestionResponseSchema,
  type QuestionResponse,
} from '@/shared/acp-protocol/protocol/question-response';
import type { QuestionResponsesRecovery } from '@/shared/schemas/question-responses-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

function summaryForBackup(input: unknown): QuestionResponse {
  const summary = QuestionResponseSchema.parse(input);
  const questions = summary.questions.map(({ id, question, header, answers, note, redacted }) => ({
    ...(id === undefined ? {} : { id }),
    question,
    ...(header === undefined ? {} : { header }),
    answers: redacted ? [] : answers,
    ...(!redacted && note !== undefined ? { note } : {}),
    ...(redacted ? { redacted } : {}),
  }));
  return {
    toolUseId: summary.toolUseId,
    requestId: summary.requestId,
    status: summary.status,
    questions,
  };
}

export async function exportQuestionResponses(
  tx: Prisma.TransactionClient
): Promise<QuestionResponsesRecovery> {
  const rows = await readSessionQuestionResponsesForBackup(tx);
  return {
    version: 1,
    responses: rows.map(({ sessionId, providerSessionId, toolUseId, timestamp, summary }) => ({
      sessionId,
      providerSessionId,
      toolUseId,
      timestamp: timestamp.toISOString(),
      summary: summaryForBackup(summary),
    })),
  };
}

export async function restoreQuestionResponses(
  tx: Prisma.TransactionClient,
  section: QuestionResponsesRecovery | undefined,
  createdSessionIds: ReadonlySet<string>
): Promise<void> {
  const rows = (section?.responses ?? [])
    .filter((row) => createdSessionIds.has(row.sessionId))
    .map((row) => ({ ...row, timestamp: new Date(row.timestamp) }));
  if (rows.length > 0) {
    await createImportedSessionQuestionResponses(tx, rows);
  }
}
