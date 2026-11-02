import { z } from 'zod';
/** Positive local proof: the provider invocation was never entered. */
export class PromptNotInvokedError extends Error {
  constructor(
    cause: unknown,
    readonly evidence = 'confirmed local rejection before provider invocation'
  ) {
    super(cause instanceof Error ? cause.message : 'Prompt rejected before provider invocation', {
      cause,
    });
  }
}

const busyRejectionSchema = z.object({
  code: z.literal(-32_600),
  data: z.object({ reason: z.literal('A turn is already in progress for this session') }),
});

/** A typed negative provider acknowledgment proves this prompt was declined. */
export class ProviderBusyDeclinedError extends PromptNotInvokedError {
  constructor(cause: unknown) {
    super(cause, 'provider explicitly declined prompt as busy without accepting input');
    this.message = 'A turn is already in progress for this session';
  }
}
export function confirmedProviderBusy(error: unknown): ProviderBusyDeclinedError | undefined {
  return busyRejectionSchema.safeParse(error).success
    ? new ProviderBusyDeclinedError(error)
    : undefined;
}
