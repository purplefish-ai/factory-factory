import { describe, expect, it } from 'vitest';
import {
  createAcpResumeError,
  getAcpErrorLogDetails,
  isMethodNotFoundError,
} from './acp-runtime-errors';

describe('ACP runtime error normalization', () => {
  it.each([-32_603, 'SESSION_NOT_FOUND', 0])(
    'retains provider code %j, diagnostics, and cause in required resume errors',
    (code) => {
      const cause = Object.assign(new Error('Internal error'), {
        code,
        data: { details: 'no rollout found for thread id native-thread' },
      });
      const error = createAcpResumeError('CODEX', 'sess_native-thread', cause);
      expect(error.message).toContain(`code ${code}`);
      expect(error.message).toContain('Internal error');
      expect(error.message).toContain('no rollout found for thread id native-thread');
      expect(error.message).toContain('sess_native-thread');
      expect(error.cause).toBe(cause);
    }
  );
  it('retains a code-free provider message without inventing an error code', () => {
    const error = createAcpResumeError(
      'CLAUDE',
      'stored-session',
      new Error('session unavailable')
    );
    expect(error.message).toContain('session unavailable');
    expect(error.message).not.toContain('code ');
  });
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
