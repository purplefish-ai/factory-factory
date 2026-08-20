import { describe, expect, it } from 'vitest';
import { getAcpErrorLogDetails, isMethodNotFoundError } from './acp-runtime-errors';

describe('ACP runtime error normalization', () => {
  it('falls back to a string when JSON serialization returns undefined', () => {
    // Catches error logging returning an invalid undefined message.
    const error = { code: -32_601, toJSON: () => undefined };

    expect(getAcpErrorLogDetails(error)).toEqual({
      message: '[object Object]',
      code: -32_601,
    });
  });

  it('checks method-not-found errors without throwing on undefined JSON output', () => {
    // Catches normalization throwing while trying to inspect the original error.
    const error = { toJSON: () => undefined };

    expect(() => isMethodNotFoundError(error)).not.toThrow();
    expect(isMethodNotFoundError(error)).toBe(false);
  });
});
