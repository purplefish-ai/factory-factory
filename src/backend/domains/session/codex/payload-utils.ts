import { parseThreadIdWithSchema, parseTurnIdWithSchema } from './schemas';

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function parseThreadId(value: unknown): string | null {
  return parseThreadIdWithSchema(value);
}

export function parseTurnId(value: unknown): string | null {
  return parseTurnIdWithSchema(value);
}
