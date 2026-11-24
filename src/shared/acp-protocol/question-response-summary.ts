import { z } from 'zod';
import type { QuestionResponse } from './protocol/question-response';
import { getAskUserQuestions } from './question-input';

const questionPresentationSchema = z.object({
  isSecret: z.boolean().optional().catch(undefined),
  secret: z.boolean().optional().catch(undefined),
  format: z.string().optional().catch(undefined),
  writeOnly: z.boolean().optional().catch(undefined),
  _meta: z
    .object({
      codex: z.object({ isSecret: z.boolean().optional() }).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
});

const companionNoteSchema = z.object({
  companionNote: z.object({ questionId: z.string(), revealOnValue: z.string().optional() }),
});

export function isSecretQuestion(input: unknown): boolean {
  const flags = questionPresentationSchema.safeParse(input).data;
  return Boolean(
    flags?.isSecret ||
    flags?.secret ||
    flags?.writeOnly ||
    flags?._meta?.codex?.isSecret ||
    flags?.format === 'password'
  );
}

type QuestionAnswers = Record<string, string[]>;

export function summarizeQuestionResponse(
  input: Record<string, unknown>,
  identity: Pick<QuestionResponse, 'toolUseId' | 'requestId'>,
  status: QuestionResponse['status'],
  answers?: QuestionAnswers
): QuestionResponse {
  const fields = getAskUserQuestions(input);
  const rawFields = Array.isArray(input.questions) ? input.questions : [];
  const pairs = fields.map((field, index) => {
    const rawField = rawFields[index];
    const key = field.id?.trim() || field.question;
    const values =
      status === 'answered' && answers && Object.hasOwn(answers, key) ? (answers[key] ?? []) : [];
    const redacted = isSecretQuestion(rawField);
    return {
      key,
      values,
      companionNote: companionNoteSchema.safeParse(rawField).data?.companionNote,
      summary: {
        ...(field.id ? { id: key } : {}),
        question: field.question,
        ...(field.header ? { header: field.header } : {}),
        answers: redacted
          ? []
          : values.map(
              (value) =>
                field.options.find((option) => (option.value ?? option.label) === value)?.label ??
                value
            ),
        ...(redacted ? { redacted: true as const } : {}),
      },
    };
  });

  const notesByParent = new Map<string, { text: string; customChoice?: string }>();
  const parentKeys = new Set(pairs.map(({ key }) => key));
  const questions = pairs.flatMap(({ key, companionNote, summary, values }) => {
    if (!(companionNote && parentKeys.has(companionNote.questionId)) || summary.redacted) {
      return [{ key, summary, values }];
    }
    if (summary.answers.length) {
      notesByParent.set(companionNote.questionId, {
        text: summary.answers.join('\n'),
        customChoice: companionNote.revealOnValue,
      });
    }
    return [];
  });

  return {
    ...identity,
    status,
    questions: questions.map(({ key, summary, values }) => {
      const note = notesByParent.get(key);
      if (!note || summary.redacted) {
        return summary;
      }
      const visibleAnswers = note.customChoice
        ? summary.answers.filter((_, index) => values[index] !== note.customChoice)
        : summary.answers;
      return { ...summary, answers: visibleAnswers, note: note.text };
    }),
  };
}
