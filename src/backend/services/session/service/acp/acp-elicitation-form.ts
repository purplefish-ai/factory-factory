import type { ElicitationContentValue } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  type AskUserQuestion,
  compileQuestionPattern,
  getStringAnswerError,
} from '@/shared/acp-protocol/question-input';

const optionSchema = z.object({
  const: z.string(),
  title: z.string(),
  description: z.string().nullish(),
});
const common = {
  title: z.string().nullish(),
  description: z.string().nullish(),
  _meta: z
    .object({ codex: z.object({ isOther: z.boolean().optional() }).passthrough().nullish() })
    .passthrough()
    .nullish(),
};
const fieldSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('string'),
    enum: z.array(z.string()).nullish(),
    oneOf: z.array(optionSchema).nullish(),
    minLength: z.number().int().nonnegative().nullish(),
    maxLength: z.number().int().nonnegative().nullish(),
    pattern: z.string().nullish(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).nullish(),
  }),
  z.object({
    ...common,
    type: z.literal('number'),
    minimum: z.number().nullish(),
    maximum: z.number().nullish(),
  }),
  z.object({
    ...common,
    type: z.literal('integer'),
    minimum: z.number().nullish(),
    maximum: z.number().nullish(),
  }),
  z.object({ ...common, type: z.literal('boolean') }),
  z.object({
    ...common,
    type: z.literal('array'),
    minItems: z.number().int().nonnegative().nullish(),
    maxItems: z.number().int().nonnegative().nullish(),
    items: z.union([
      z.object({ type: z.literal('string'), enum: z.array(z.string()) }),
      z.object({ anyOf: z.array(optionSchema) }),
    ]),
  }),
]);
const formSchema = z.object({
  type: z.literal('object').optional(),
  properties: z.record(z.string(), fieldSchema).default({}),
  required: z.array(z.string()).nullish(),
});
const answersSchema = z.record(z.string(), z.array(z.string()));
type Field = z.infer<typeof fieldSchema>;
type Form = z.infer<typeof formSchema>;

function choices(field: Field): Array<{ label: string; description: string }> {
  if (field.type === 'boolean') {
    return [
      { label: 'true', description: '' },
      { label: 'false', description: '' },
    ];
  }
  if (field.type === 'string') {
    if (field.oneOf) {
      return field.oneOf.map((option) => ({
        label: option.const,
        description: [option.title, option.description].filter(Boolean).join(' — '),
      }));
    }
    return field.enum?.map((label) => ({ label, description: '' })) ?? [];
  }
  if (field.type === 'array') {
    return 'anyOf' in field.items
      ? field.items.anyOf.map((option) => ({
          label: option.const,
          description: [option.title, option.description].filter(Boolean).join(' — '),
        }))
      : field.items.enum.map((label) => ({ label, description: '' }));
  }
  return [];
}

/** Give blank provider values a visible label and a nonempty UI selection token. */
function displayChoices(field: Field) {
  const options = choices(field);
  const usedValues = new Set(options.map((option) => option.label));
  return options.map((option, index) => {
    if (option.label.trim() && option.label !== '__other__') {
      return option;
    }
    let value = `__elicitation_option_${index}__`;
    while (usedValues.has(value)) {
      value += '_';
    }
    usedValues.add(value);
    return {
      ...option,
      label: option.label.trim() ? option.label : option.label ? 'Whitespace value' : 'Empty value',
      value,
    };
  });
}

function decodeAnswers(field: Field, answers: string[] | undefined): string[] | undefined {
  const rawOptions = choices(field);
  const displayed = displayChoices(field);
  return answers?.map((answer) => {
    const index = displayed.findIndex((option) => 'value' in option && option.value === answer);
    return index < 0 ? answer : (rawOptions[index]?.label ?? answer);
  });
}

function questionValidation(field: Field): AskUserQuestion['validation'] {
  switch (field.type) {
    case 'number':
    case 'integer':
      return {
        type: field.type,
        minimum: field.minimum ?? undefined,
        maximum: field.maximum ?? undefined,
      };
    case 'string':
      return {
        type: 'string',
        minLength: field.minLength ?? undefined,
        maxLength: field.maxLength ?? undefined,
        pattern: field.pattern ?? undefined,
        format: field.format ?? undefined,
      };
    case 'array':
      return {
        type: 'array',
        minItems: field.minItems ?? undefined,
        maxItems: field.maxItems ?? undefined,
      };
    default:
      return undefined;
  }
}

function stringValidator(field: Extract<Field, { type: 'string' }>): z.ZodType<string> {
  if (field.pattern != null) {
    // Reject unsupported patterns before showing a form that cannot be answered.
    compileQuestionPattern(field.pattern);
  }
  const rules = {
    type: 'string' as const,
    minLength: field.minLength ?? undefined,
    maxLength: field.maxLength ?? undefined,
    pattern: field.pattern ?? undefined,
    format: field.format ?? undefined,
  };
  return z
    .string()
    .refine(
      (input) => getStringAnswerError(rules, input) === null && isAllowedStringChoice(field, input)
    );
}

function isAllowedStringChoice(field: Extract<Field, { type: 'string' }>, input: string): boolean {
  if (field._meta?.codex?.isOther === true) {
    return true;
  }
  return (
    (!field.enum || field.enum.includes(input)) &&
    (!field.oneOf || field.oneOf.some((option) => option.const === input))
  );
}

function allowsOtherAnswer(field: Field): boolean {
  if (field.type === 'string' && (field.enum || field.oneOf)) {
    return field._meta?.codex?.isOther === true;
  }
  return field.type !== 'boolean' && field.type !== 'array';
}

function arrayValidator(field: Extract<Field, { type: 'array' }>): z.ZodType<string[]> {
  const options = choices(field).map((option) => option.label);
  let value = z.array(z.string().refine((item) => options.includes(item)));
  if (field.minItems != null) {
    value = value.min(field.minItems);
  }
  if (field.maxItems != null) {
    value = value.max(field.maxItems);
  }
  return value.refine((items) => new Set(items).size === items.length);
}

function numberValidator(field: Extract<Field, { type: 'number' | 'integer' }>): z.ZodType<number> {
  let value = z.number();
  if (field.type === 'integer') {
    value = value.int();
  }
  if (field.minimum != null) {
    value = value.min(field.minimum);
  }
  if (field.maximum != null) {
    value = value.max(field.maximum);
  }
  return value;
}

function validator(field: Field): z.ZodType<ElicitationContentValue> {
  switch (field.type) {
    case 'string':
      return stringValidator(field);
    case 'array':
      return arrayValidator(field);
    case 'boolean':
      return z.boolean();
    default:
      return numberValidator(field);
  }
}

function convertAnswer(field: Field, answers: string[]): ElicitationContentValue | undefined {
  if (field.type === 'array') {
    return answers;
  }
  if (answers.length !== 1) {
    return undefined;
  }
  const answer = answers[0] ?? '';
  if (field.type === 'boolean') {
    return answer === 'true' ? true : answer === 'false' ? false : undefined;
  }
  if (field.type === 'integer' || field.type === 'number') {
    return /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(answer.trim())
      ? Number(answer)
      : undefined;
  }
  return answer;
}

export interface AcpElicitationForm {
  questions: AskUserQuestion[];
  parseAnswers: (answers: unknown) => Record<string, ElicitationContentValue> | null;
}

function validateFieldAnswer(
  field: Field,
  input: string[] | undefined,
  valueValidator: z.ZodType<ElicitationContentValue> | undefined,
  required: boolean
): ElicitationContentValue | null | undefined {
  if (!input || (input.length === 0 && field.type !== 'array')) {
    return required ? null : undefined;
  }
  const validated = valueValidator?.safeParse(convertAnswer(field, input));
  return validated?.success ? validated.data : null;
}

function parseAnswers(
  form: Form,
  validators: Map<string, z.ZodType<ElicitationContentValue>>,
  questionIds: Map<string, string>,
  answers: unknown
): Record<string, ElicitationContentValue> | null {
  const parsed = answersSchema.safeParse(answers ?? {});
  if (!parsed.success) {
    return null;
  }
  const required = new Set(form.required ?? []);
  const content: Record<string, ElicitationContentValue> = {};
  for (const [id, field] of Object.entries(form.properties)) {
    const questionId = questionIds.get(id) ?? id;
    const input = Object.hasOwn(parsed.data, questionId) ? parsed.data[questionId] : undefined;
    const value = validateFieldAnswer(
      field,
      decodeAnswers(field, input),
      validators.get(id),
      required.has(id)
    );
    if (value === null) {
      return null;
    }
    if (value !== undefined) {
      Object.defineProperty(content, id, { value, enumerable: true });
    }
  }
  return content;
}

/** Convert the supported ACP primitive schema into the application's question UI. */
export function createAcpElicitationForm(schema: unknown): AcpElicitationForm | null {
  const parsed = formSchema.safeParse(schema);
  if (!parsed.success) {
    return null;
  }
  const form = parsed.data;
  if (form.required?.some((id) => !Object.hasOwn(form.properties, id))) {
    return null;
  }
  try {
    const validators = new Map(
      Object.entries(form.properties).map(([id, field]) => [id, validator(field)])
    );
    const usedIds = new Set(Object.keys(form.properties));
    const questionIds = new Map(
      Object.keys(form.properties).map((id, index) => {
        if (id.trim() === id && id.length > 0) {
          return [id, id];
        }
        let questionId = `elicitation-field-${index}`;
        while (usedIds.has(questionId)) {
          questionId += '-';
        }
        usedIds.add(questionId);
        return [id, questionId];
      })
    );
    const questions = Object.entries(form.properties).map(([id, field]): AskUserQuestion => ({
      id: questionIds.get(id) ?? id,
      question: field.title?.trim() || id.trim() || 'Input',
      ...(field.description ? { header: field.description } : {}),
      options: displayChoices(field),
      validation: questionValidation(field),
      allowOther: allowsOtherAnswer(field),
      ...(!form.required?.includes(id) ? { optional: true } : {}),
      ...(field.type === 'array' ? { multiSelect: true } : {}),
    }));
    return {
      questions,
      parseAnswers: (answers) => parseAnswers(form, validators, questionIds, answers),
    };
  } catch {
    // Invalid regular expressions or contradictory constraints cannot be safely rendered.
    return null;
  }
}
