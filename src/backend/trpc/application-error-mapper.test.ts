import { describe, expect, it } from 'vitest';
import { ApplicationError, type ApplicationErrorCode } from '@/backend/lib/application-error';
import { toTRPCError } from './application-error-mapper';

const mappings: Array<{
  applicationCode: ApplicationErrorCode;
  trpcCode:
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'PRECONDITION_FAILED'
    | 'CONFLICT'
    | 'INTERNAL_SERVER_ERROR';
}> = [
  { applicationCode: 'INVALID_INPUT', trpcCode: 'BAD_REQUEST' },
  { applicationCode: 'NOT_FOUND', trpcCode: 'NOT_FOUND' },
  { applicationCode: 'PRECONDITION_FAILED', trpcCode: 'PRECONDITION_FAILED' },
  { applicationCode: 'CONFLICT', trpcCode: 'CONFLICT' },
  { applicationCode: 'INTERNAL_ERROR', trpcCode: 'INTERNAL_SERVER_ERROR' },
];

describe('toTRPCError', () => {
  it.each(mappings)('maps $applicationCode to $trpcCode and retains the message and cause', ({
    applicationCode,
    trpcCode,
  }) => {
    const cause = new Error('internal detail');
    const applicationError = new ApplicationError(applicationCode, 'Public message', { cause });

    const error = toTRPCError(applicationError);

    expect(error).toMatchObject({
      code: trpcCode,
      message: 'Public message',
    });
    expect(error.cause).toBe(applicationError);
  });
});
