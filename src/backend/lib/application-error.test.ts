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
      code,
      message: 'Public message',
      cause,
    });
  });
});
