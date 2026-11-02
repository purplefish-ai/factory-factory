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
