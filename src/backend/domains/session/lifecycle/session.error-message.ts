export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error !== null && typeof error === 'object') {
    return JSON.stringify(error);
  }
  return String(error);
}
