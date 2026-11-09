export type ApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export type ApplicationErrorKind =
  | 'GIT_INDEX_LOCKED'
  /** A background prompt could not start because the session's turn slot is taken. */
  | 'SESSION_TURN_BUSY'
  /** A background prompt required its exact stored provider conversation, which failed to resume. */
  | 'SESSION_RESUME_FAILED';

export interface ApplicationErrorOptions extends ErrorOptions {
  kind?: ApplicationErrorKind;
}

export class ApplicationError extends Error {
  public readonly kind: ApplicationErrorKind | undefined;

  constructor(
    public readonly code: ApplicationErrorCode,
    message: string,
    options?: ApplicationErrorOptions
  ) {
    super(message, options);
    this.name = 'ApplicationError';
    this.kind = options?.kind;
  }
}
