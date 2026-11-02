import { ApplicationError } from './application-error';
/** A rejected captured setup continuation; it must not fail queued user input. */
export class WorkspaceInitFenceError extends ApplicationError {
  constructor() {
    super(
      'PRECONDITION_FAILED',
      'Event initial work prevents setup retry, or its authority is unavailable.'
    );
    this.name = 'WorkspaceInitFenceError';
  }
}
