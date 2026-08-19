import type { AcpRuntimeEvent, AcpRuntimePurpose } from './acp-runtime-events';

export class AcpRuntimeActivity {
  private readonly activeTaskSessions = new Set<string>();
  private readonly browseOnlySessions = new Set<string>();

  isBrowseOnly(sessionId: string): boolean {
    return this.browseOnlySessions.has(sessionId);
  }

  recordPurpose(sessionId: string, purpose: AcpRuntimePurpose | undefined): void {
    if (purpose === 'browse') {
      this.browseOnlySessions.add(sessionId);
      this.activeTaskSessions.delete(sessionId);
      return;
    }
    this.browseOnlySessions.delete(sessionId);
  }

  promote(sessionId: string): void {
    this.browseOnlySessions.delete(sessionId);
  }

  clearIfUnused(sessionId: string, isInUse: boolean): void {
    if (!isInUse) {
      this.clear(sessionId);
    }
  }

  clear(sessionId: string): void {
    this.browseOnlySessions.delete(sessionId);
    this.activeTaskSessions.delete(sessionId);
  }

  recordEvent(sessionId: string, event: AcpRuntimeEvent): void {
    if (event.type !== 'acp_task_status_changed') {
      return;
    }
    if (event.active) {
      this.activeTaskSessions.add(sessionId);
    } else {
      this.activeTaskSessions.delete(sessionId);
    }
  }

  isWorking(sessionId: string, isPromptInFlight: boolean): boolean {
    return (
      !this.browseOnlySessions.has(sessionId) &&
      (isPromptInFlight || this.activeTaskSessions.has(sessionId))
    );
  }
}
