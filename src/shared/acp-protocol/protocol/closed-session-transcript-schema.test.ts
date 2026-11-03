import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { ArchivedJsonValueSchema } from './archived-content-schema';
import {
  ClosedSessionReadTranscriptSchema,
  parseClosedSessionReadTranscript,
} from './closed-session-transcript-schema';

describe('compatible closed-session envelope', () => {
  it('retains legacy role/content and summary without fabricating current metadata', () => {
    const legacy = {
      messages: [{ role: 'user', content: 'hello' }],
      sessionSummary: 'Test summary',
    };
    const parsed = ClosedSessionReadTranscriptSchema.parse(legacy);
    expectTypeOf(parsed.messages).toEqualTypeOf<z.infer<typeof ArchivedJsonValueSchema>[]>();
    expect(parsed).toEqual(legacy);
  });

  it('preserves synthetic opaque extras and own reserved keys at every JSON depth', () => {
    const encoded =
      '{"__proto__":{"envelope":true},"metadata":{"__proto__":{"meta":true}},"version":["future"],"sessionSummary":{"x":1},"messages":[{"type":"future","__proto__":{"message":true},"children":[{"__proto__":{"child":true}}],"tool":{"input":{"__proto__":{"tool":true}}}},null,3,[false]]}';
    const raw: unknown = JSON.parse(encoded);
    const parsed = ClosedSessionReadTranscriptSchema.parse(raw);
    expect(parsed).toEqual(raw);
    expect(JSON.stringify(parsed)).toBe(encoded);
    const visit = (value: unknown): number => {
      if (!value || typeof value !== 'object') {
        return 0;
      }
      return (
        Number(Object.hasOwn(value, '__proto__')) +
        Object.values(value).reduce<number>((count, child) => count + visit(child), 0)
      );
    };
    expect(visit(parsed)).toBe(5);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it.each([
    { metadata: null, version: ['future'], sessionSummary: { x: 1 }, messages: [] },
    {
      messages: [
        {
          id: 'current',
          source: 'user',
          text: 'rich',
          timestamp: '',
          order: 0,
          extra: { keep: true },
        },
      ],
    },
  ])('leaves optional envelope fields and current extras opaque %#', (value) => {
    expect(ClosedSessionReadTranscriptSchema.parse(value)).toEqual(value);
  });

  it('keeps the messages issue path for absent and JSON-valued nonarray fields', () => {
    for (const value of [{}, { messages: null }, { messages: {} }, { messages: 1 }]) {
      expect(ClosedSessionReadTranscriptSchema.safeParse(value)).toMatchObject({
        success: false,
        error: {
          issues: [
            { code: 'custom', path: ['messages'], message: 'Expected a messages JSON array' },
          ],
        },
      });
    }
  });

  it.each([
    null,
    1,
    'text',
    [],
    {},
    { messages: null },
    { messages: {} },
    { messages: 'x' },
    { messages: [undefined] },
    { messages: [{ nested: [undefined] }] },
    { messages: [{ nested: { invalid: Infinity } }] },
    { messages: [], extension: { invalid: undefined } },
  ])('rejects non-JSON or nonarray envelopes %#', (value) => {
    expect(ClosedSessionReadTranscriptSchema.safeParse(value).success).toBe(false);
  });
});

describe('closed-session JSON text decode', () => {
  it('requires text and preserves reserved fields in validated decoded JSON', () => {
    const encoded =
      '{"__proto__":{"kept":1},"messages":[{"constructor":{"extra":true},"prototype":[null]}]}';
    expect(JSON.stringify(parseClosedSessionReadTranscript(encoded))).toBe(encoded);
  });

  it.each([
    undefined,
    null,
    1,
    { messages: [] },
    'not JSON',
    'null',
    '[]',
    '{}',
    '{"messages":false}',
  ])('rejects invalid wire or envelope %#', (wire) => {
    expect(() => parseClosedSessionReadTranscript(wire)).toThrow();
  });
});
