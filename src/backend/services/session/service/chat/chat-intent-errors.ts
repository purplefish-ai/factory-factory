export class UncertainChatDispatchError extends Error {
  constructor(
    readonly attemptId: string,
    options?: ErrorOptions
  ) {
    super(
      `Delivery outcome is uncertain (batch ${attemptId}). Check provider history before submitting again. This batch will not be resent automatically.`,
      options
    );
  }
}
