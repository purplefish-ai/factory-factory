/**
 * The single ordered teardown of an application graph.
 *
 * Server shutdown (`createServer().stop()`) and `disposeApplication` both run
 * this list, so a component stopped on one path is stopped on the other. The
 * server contributes its own transport and timer work through hooks placed at
 * fixed points; without a server those hooks are no-ops.
 *
 * Structural rather than `Application`-typed so this module does not import
 * the composition root that imports it.
 */

type Stop = () => Promise<void> | void;

export type ShutdownGraph = {
  readonly services: {
    readonly applicationUpdateService?: { stop(): Promise<void> };
    readonly reconciliationService: { stopPeriodicCleanup(): Promise<void> };
    readonly schedulerService: { stop(): Promise<void> };
    readonly ratchetService: { stop(): Promise<void> };
    readonly periodicTaskService: { stop(): Promise<void> };
    readonly agentRuntime?: { stop(): Promise<void> };
    readonly workspaceMetadata?: { stop(): Promise<void> };
    readonly sessionLifecycleService: { stopAllClients(timeoutMs?: number): Promise<void> };
    readonly sessionDispatchService: { shutdown(): Promise<void> };
    readonly codexAccountService: { shutdown(): Promise<void> };
    readonly terminalService: { cleanup(): void };
    readonly runScriptService: { cleanup(): Promise<void> };
    readonly portShareService: { cleanup(): Promise<void> };
    readonly sessionFileLogger: { cleanup(): void };
    readonly acpTraceLogger: { cleanup(): void };
    readonly rateLimiter: { stop(): Promise<void> };
    readonly workspaceGitStateService: { stop(): void };
  };
  readonly lifecycle: {
    readonly interceptors: { stop(): Promise<void> };
    readonly eventCollector: { stop(): void };
    readonly snapshotReconciliation: { stop(): Promise<void> };
    readonly jobs: { stopAll(): Promise<void> };
    readonly database: { $disconnect(): Promise<void> };
  };
};

export type ServerShutdownHooks = {
  /** Server work that still uses sessions, caches and the database, then its timers. */
  readonly settleServerWork?: Stop;
  /** WebSocket clients, chat/snapshot transport state and the HTTP listener. */
  readonly closeTransports?: Stop;
};

export const SESSION_SHUTDOWN_TIMEOUT_MS = 5000;

export type ShutdownJob = { readonly name: string; readonly stop: Stop };
export type ShutdownStep = {
  readonly name: string;
  readonly stop: Stop;
  /** Jobs whose drain must settle before this step runs. */
  readonly after?: readonly string[];
};

export type ShutdownPlan = {
  /** Signalled together when shutdown begins; their in-flight runs drain concurrently. */
  readonly jobs: readonly ShutdownJob[];
  /** Run one at a time, in order. */
  readonly steps: readonly ShutdownStep[];
};

export function createShutdownPlan(
  { services, lifecycle }: ShutdownGraph,
  hooks: ServerShutdownHooks = {}
): ShutdownPlan {
  const jobs: ShutdownJob[] = [
    { name: 'application-update-idle', stop: () => services.applicationUpdateService?.stop() },
    {
      name: 'reconciliation-cleanup',
      stop: () => services.reconciliationService.stopPeriodicCleanup(),
    },
    { name: 'pr-poll', stop: () => services.schedulerService.stop() },
    { name: 'snapshot-reconciliation', stop: () => lifecycle.snapshotReconciliation.stop() },
    { name: 'pr-event-poll', stop: () => services.ratchetService.stop() },
    { name: 'periodic-task-poll', stop: () => services.periodicTaskService.stop() },
  ];
  const steps: ShutdownStep[] = [
    // Agent intake closes admission and drains committed launches before
    // sessions stop, so new agent work fails fast instead of racing teardown.
    { name: 'agent-runtime', stop: () => services.agentRuntime?.stop() },
    { name: 'server-work', stop: () => hooks.settleServerWork?.() },
    { name: 'interceptors', stop: () => lifecycle.interceptors.stop() },
    { name: 'workspace-metadata', stop: () => services.workspaceMetadata?.stop() },
    { name: 'transports', stop: () => hooks.closeTransports?.() },
    {
      name: 'sessions',
      stop: () => services.sessionLifecycleService.stopAllClients(SESSION_SHUTDOWN_TIMEOUT_MS),
    },
    // Stopping every client skips per-session stops, which own queue retries;
    // cancel the retries the teardown itself armed before the database closes.
    { name: 'session-dispatch', stop: () => services.sessionDispatchService.shutdown() },
    // Session teardown retains its final observation drain, which still reads
    // account context; cancelling an in-flight login waits until it settles.
    { name: 'codex-accounts', stop: () => services.codexAccountService.shutdown() },
    { name: 'terminals', stop: () => services.terminalService.cleanup() },
    { name: 'run-scripts', stop: () => services.runScriptService.cleanup() },
    { name: 'port-shares', stop: () => services.portShareService.cleanup() },
    { name: 'session-file-logger', stop: () => services.sessionFileLogger.cleanup() },
    { name: 'acp-trace-logger', stop: () => services.acpTraceLogger.cleanup() },
    { name: 'rate-limiter', stop: () => services.rateLimiter.stop() },
    // Every drain is already under way, so waiting on them here costs only the
    // slowest; these edges just keep the orderings that matter. The event
    // collector keeps projecting until the PR poll has settled.
    {
      name: 'event-collector',
      after: ['application-update-idle', 'pr-poll'],
      stop: () => lifecycle.eventCollector.stop(),
    },
    // Snapshot reconciliation's Git-stats pass must settle before the Git
    // state service drops its watchers and cache.
    {
      name: 'workspace-git-state',
      after: ['snapshot-reconciliation'],
      stop: () => services.workspaceGitStateService.stop(),
    },
    // Backstop for any registered job without an owner above, so none is still
    // running when the database disconnects.
    {
      name: 'job-runner',
      after: ['pr-event-poll', 'periodic-task-poll', 'reconciliation-cleanup'],
      stop: () => lifecycle.jobs.stopAll(),
    },
    { name: 'database', stop: () => lifecycle.database.$disconnect() },
  ];
  return { jobs, steps };
}

export type ShutdownFailure = {
  readonly kind: 'job' | 'step';
  readonly name: string;
  readonly error: unknown;
};

function attempt(stop: Stop): Promise<void> {
  try {
    return Promise.resolve(stop());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Run the plan. Every job and step is attempted even when an earlier one
 * fails, and each failure is reported as it happens; the caller decides
 * whether failures reject. A failed job drain never blocks the steps waiting
 * on it.
 */
export async function runShutdownPlan(
  plan: ShutdownPlan,
  report: (failure: ShutdownFailure) => void
): Promise<void> {
  const drains = new Map(
    plan.jobs.map((job) => [
      job.name,
      attempt(job.stop).catch((error: unknown) => {
        report({ kind: 'job', name: job.name, error });
      }),
    ])
  );
  for (const step of plan.steps) {
    for (const job of step.after ?? []) {
      await drains.get(job);
    }
    try {
      await attempt(step.stop);
    } catch (error) {
      report({ kind: 'step', name: step.name, error });
    }
  }
  // Every drain settles before shutdown completes, including any a step did not name.
  await Promise.all(drains.values());
}
