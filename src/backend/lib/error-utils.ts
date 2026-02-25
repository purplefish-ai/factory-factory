export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export function toErrorMessage(error: unknown): string {
  return toError(error).message;
}
