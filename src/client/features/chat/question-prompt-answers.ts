import type { AskUserQuestion } from '@/lib/chat-protocol';
import { getStringAnswerError } from '@/shared/acp-protocol/question-validation';

export function getOtherOptionValue(question: AskUserQuestion): string {
  const values = new Set(question.options?.map((option) => option.value ?? option.label));
  let other = '__other__';
  while (values.has(other)) {
    other += '_';
  }
  return other;
}

function normalizeOtherText(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function isAnswerComplete(
  question: AskUserQuestion,
  answer: string | string[] | undefined,
  otherText: string
): boolean {
  const OTHER_OPTION_VALUE = getOtherOptionValue(question);
  const normalizedOther = normalizeOtherText(otherText);
  if (question.multiSelect) {
    if (!Array.isArray(answer) || answer.length === 0) {
      return question.optional === true;
    }
    const hasUnfilledOther = answer.includes(OTHER_OPTION_VALUE) && normalizedOther.length === 0;
    if (hasUnfilledOther && !question.optional) {
      return false;
    }
    return !getArrayAnswerError(question, answer, otherText);
  }
  if (typeof answer !== 'string' || answer.length === 0) {
    return question.optional === true;
  }
  if (answer === OTHER_OPTION_VALUE) {
    return normalizedOther
      ? !getAnswerError(question, normalizedOther)
      : question.optional === true;
  }
  return true;
}

export function formatAnswer(
  question: AskUserQuestion,
  answer: string | string[] | undefined,
  otherText: string
): string | string[] {
  const OTHER_OPTION_VALUE = getOtherOptionValue(question);
  const normalizedOther = normalizeOtherText(otherText);
  if (answer === undefined) {
    return question.multiSelect ? [] : '';
  }
  if (question.multiSelect && Array.isArray(answer)) {
    if (answer.includes(OTHER_OPTION_VALUE)) {
      if (normalizedOther) {
        return answer.map((value) => (value === OTHER_OPTION_VALUE ? normalizedOther : value));
      }
      return answer.filter((value) => value !== OTHER_OPTION_VALUE);
    }
    return answer;
  }
  if (!question.multiSelect && answer === OTHER_OPTION_VALUE && normalizedOther) {
    return normalizedOther;
  }
  if (!question.multiSelect && answer === OTHER_OPTION_VALUE) {
    return '';
  }
  return answer as string;
}

export function getAnswerError(question: AskUserQuestion, text: string): string | null {
  const rules = question.validation;
  if (!(rules && text.trim())) {
    return null;
  }
  if (rules.type === 'string') {
    return getStringAnswerError(rules, text.trim());
  }
  if (rules.type === 'array') {
    return null;
  }
  const value = Number(text);
  if (!(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) && Number.isFinite(value))) {
    return 'Enter a number.';
  }
  if (rules.type === 'integer' && !Number.isSafeInteger(value)) {
    return 'Enter a whole number.';
  }
  if (rules.minimum !== undefined && value < rules.minimum) {
    return `Enter a number greater than or equal to ${rules.minimum}.`;
  }
  if (rules.maximum !== undefined && value > rules.maximum) {
    return `Enter a number less than or equal to ${rules.maximum}.`;
  }
  return null;
}

export function getArrayAnswerError(
  question: AskUserQuestion,
  answer: string[],
  otherText: string
): string | null {
  const rules = question.validation;
  if (rules?.type !== 'array') {
    return null;
  }
  const values = formatAnswer(question, answer, otherText);
  if (!Array.isArray(values) || (question.optional && values.length === 0)) {
    return null;
  }
  if (rules.minItems !== undefined && values.length < rules.minItems) {
    return `Select at least ${rules.minItems} options.`;
  }
  if (rules.maxItems !== undefined && values.length > rules.maxItems) {
    return `Select at most ${rules.maxItems} options.`;
  }
  if (new Set(values).size !== values.length) {
    return 'Select distinct values.';
  }
  return null;
}
