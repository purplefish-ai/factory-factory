import type { PRFactPayload, PRMonitoringEventPayload } from './schemas/pr-event.schema';

export interface PREventDraft {
  kind: PRMonitoringEventPayload['kind'];
  deduplicationKey: string;
  payload: PRMonitoringEventPayload;
}
export interface PRFactDraft extends PREventDraft {
  kind: PRFactPayload['kind'];
  payload: PRFactPayload;
}
export interface PREventSummary {
  id: string;
  kind: PRFactPayload['kind'];
  payload: PRFactPayload;
  deduplicationKey?: string;
}
