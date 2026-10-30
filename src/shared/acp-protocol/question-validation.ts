import { RE2JS } from 're2js';
import { z } from 'zod';

export const questionValidationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['number', 'integer']),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }),
  z.object({
    type: z.literal('string'),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  }),
  z.object({
    type: z.literal('array'),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  }),
]);

export type QuestionValidation = z.infer<typeof questionValidationSchema>;

// Conservatively bound counted repetition expansion before compiling untrusted patterns.
// Counting escaped/class-contained braces too may reject a safe pattern; it never
// allows a larger expansion. Unsupported patterns fail closed in both callers.
function checkPatternBudget(pattern: string): void {
  let budget = pattern.length;
  for (const match of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const repetitions = Math.max(Number(match[1]), Number(match[2] || 0), 1);
    budget *= repetitions;
    if (budget > 16_384) {
      throw new Error('Response pattern expands too far');
    }
  }
}

// Bound both compilation work and retained provider-controlled patterns.
const patterns = new Map<string, RE2JS>();
let cachedProgramSize = 0;
export function compileQuestionPattern(pattern: string): RE2JS {
  if (pattern.length > 1024) {
    throw new Error('Response pattern is too long');
  }
  const cached = patterns.get(pattern);
  if (cached) {
    return cached;
  }
  checkPatternBudget(pattern);
  const compiled = RE2JS.compile(pattern);
  const size = compiled.programSize();
  if (size > 4096) {
    throw new Error('Response pattern is too complex');
  }
  while (patterns.size >= 64 || cachedProgramSize + size > 16_384) {
    const oldest = patterns.keys().next().value;
    if (oldest !== undefined) {
      cachedProgramSize -= patterns.get(oldest)?.programSize() ?? 0;
      patterns.delete(oldest);
    }
  }
  patterns.set(pattern, compiled);
  cachedProgramSize += size;
  return compiled;
}

const formats = {
  email: { schema: z.email(), message: 'Enter a valid email address.' },
  uri: { schema: z.url(), message: 'Enter a valid URL.' },
  date: { schema: z.iso.date(), message: 'Enter a date in YYYY-MM-DD format.' },
  'date-time': {
    schema: z.iso.datetime({ offset: true }),
    message: 'Enter a date and time with a timezone.',
  },
};

export function getStringAnswerError(
  rules: Extract<QuestionValidation, { type: 'string' }>,
  text: string
): string | null {
  // JSON Schema string lengths count Unicode code points, not UTF-16 code units.
  const length = [...text].length;
  if (rules.minLength !== undefined && length < rules.minLength) {
    return `Enter at least ${rules.minLength} characters.`;
  }
  if (rules.maxLength !== undefined && length > rules.maxLength) {
    return `Enter no more than ${rules.maxLength} characters.`;
  }
  if (rules.pattern !== undefined) {
    try {
      if (!compileQuestionPattern(rules.pattern).matcher(text).find()) {
        return 'Use the requested format.';
      }
    } catch {
      return 'The requested response format is unsupported.';
    }
  }
  const format = rules.format ? formats[rules.format] : undefined;
  return format && !format.schema.safeParse(text).success ? format.message : null;
}
