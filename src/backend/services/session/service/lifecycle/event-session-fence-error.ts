import { ApplicationError } from '@/backend/lib/application-error';

/** Expected policy hold, distinct from unavailable or malformed durable authority. */
export class EventSessionFenceError extends ApplicationError {
  constructor() {
    super('PRECONDITION_FAILED', 'Event initial delivery is fenced; inspect its durable run state');
  }
}
