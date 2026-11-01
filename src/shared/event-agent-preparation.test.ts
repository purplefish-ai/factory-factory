import { expect, it } from 'vitest';
import { classifyEventPreparationFailure } from './event-agent-preparation';

it.each([undefined, 0, 90_000, -1, Number.NaN, Infinity, '90000'])(
  'classifies a known code independently of optional Retry-After %s',
  (retryAfterMs) => {
    const expected =
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? { category: 'TRANSIENT', retryAfterMs }
        : { category: 'TRANSIENT' };
    expect(classifyEventPreparationFailure({ code: 'ECONNRESET', retryAfterMs })).toEqual(expected);
  }
);
it.each([undefined, 'UNRECOGNIZED'])(
  'does not infer a transient code from a hint or message (%s)',
  (code) => {
    expect(
      classifyEventPreparationFailure({ code, retryAfterMs: 1000, message: 'ECONNRESET' })
    ).toEqual({ category: 'UNKNOWN' });
  }
);
