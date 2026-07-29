import { describe, expect, it } from 'vitest';
import { ApplicationError, type ApplicationErrorCode } from './application-error';

const applicationErrorCodes: ApplicationErrorCode[] = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'CONFLICT',
  'INTERNAL_ERROR',
];

describe('ApplicationError', () => {
  it.each(applicationErrorCodes)('retains the %s code, message, and cause', (code) => {
    const cause = new Error('internal detail');
    const error = new ApplicationError(code, 'Public message', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'ApplicationError',
      code,
      message: 'Public message',
      cause,
    });
  });

  it('retains a machine-readable error kind', () => {
    const error = new ApplicationError('CONFLICT', 'Git index is locked', {
      kind: 'GIT_INDEX_LOCKED',
    });

    expect(error).toMatchObject({
      code: 'CONFLICT',
      kind: 'GIT_INDEX_LOCKED',
      message: 'Git index is locked',
    });
  });
});
