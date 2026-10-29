/** An admitted timer run, correlated with its existing execution reservation. */
export interface PeriodicTaskTimerEvent {
  kind: 'timer_due';
  executionId: string;
  periodicTaskId: string;
  projectId: string;
  name: string;
  prompt: string;
}
