import type { QuestionResponse } from './protocol/question-response';
import { getAskUserQuestions, isSecretQuestion } from './question-input';

type QuestionAnswers = Record<string, string[]>;

/** Codex delivers a question's selections and optional note together as answer text. */
export function normalizeCodexAsyncQuestionResponse(summary: QuestionResponse): QuestionResponse {
  return {
    ...summary,
    questions: summary.questions.map(({ question, answers, note, redacted }) => {
      const text = [...answers, note ?? ''].filter((part) => part.trim()).join('\n\n');
      return {
        question: question.trim(),
        answers: text && !redacted ? [text] : [],
        ...(redacted ? { redacted } : {}),
      };
    }),
  };
}

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
      companionNote: field.companionNote,
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

  const notesByParent = new Map<string, { texts: string[]; customChoices: Set<string> }>();
  const parentKeys = new Set(pairs.map(({ key }) => key));
  const questions = pairs.flatMap(({ key, companionNote, summary, values }) => {
    if (!(companionNote && parentKeys.has(companionNote.questionId)) || summary.redacted) {
      return [{ key, summary, values }];
    }
    if (summary.answers.length) {
      const note = notesByParent.get(companionNote.questionId) ?? {
        texts: [],
        customChoices: new Set<string>(),
      };
      note.texts.push(summary.answers.join('\n'));
      if (companionNote.revealOnValue) {
        note.customChoices.add(companionNote.revealOnValue);
      }
      notesByParent.set(companionNote.questionId, note);
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
      const visibleAnswers = summary.answers.filter(
        (_, index) => !note.customChoices.has(values[index] ?? '')
      );
      return { ...summary, answers: visibleAnswers, note: note.texts.join('\n') };
    }),
  };
}
