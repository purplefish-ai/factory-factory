import { TRPCError } from '@trpc/server';
import type { ApplicationError, ApplicationErrorCode } from '@/backend/lib/application-error';

const trpcCodeByApplicationCode: Record<ApplicationErrorCode, TRPCError['code']> = {
  INVALID_INPUT: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_SERVER_ERROR',
};

export function toTRPCError(error: ApplicationError): TRPCError {
  return new TRPCError({
    code: trpcCodeByApplicationCode[error.code],
    message: error.message,
    cause: error,
  });
}
