import { describe, expect, it } from 'vitest';
import { ClosedSessionReadTranscriptSchema } from './closed-session-transcript-schema';

describe('compatible closed-session envelope', () => {
  it('retains legacy role/content and summary without fabricating current metadata', () => {
    const legacy = {
      messages: [{ role: 'user', content: 'hello' }],
      sessionSummary: 'Test summary',
    };
    expect(ClosedSessionReadTranscriptSchema.parse(legacy)).toEqual(legacy);
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
  ])('rejects non-JSON or nonarray envelopes %#', (value) => {
    expect(ClosedSessionReadTranscriptSchema.safeParse(value).success).toBe(false);
  });
});
