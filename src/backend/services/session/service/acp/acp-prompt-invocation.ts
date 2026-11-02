/** Positive local proof: the provider invocation was never entered. */
export class PromptNotInvokedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Prompt rejected before provider invocation', {
      cause,
    });
  }
}
