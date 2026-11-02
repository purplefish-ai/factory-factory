import type { PrismaModelName } from '@/backend/services/registry';

type Coverage = {
  category: 'config' | 'history' | 'evidence' | 'cache' | 'runtime' | 'secret';
  handling: 'included' | 'partial' | 'excluded';
  reason: string;
};

/** Explicit per-model promises; adding a model requires a recovery decision. */
export const recoveryModelCoverage = {
  Project: {
    category: 'config',
    handling: 'partial',
    reason: 'Repository metadata; encrypted issue credentials and filesystem excluded.',
  },
  Workspace: {
    category: 'history',
    handling: 'partial',
    reason: 'Metadata and hierarchy; no worktree files or active processes restored.',
  },
  WorkspaceMetadata: {
    category: 'history',
    handling: 'included',
    reason: 'Generated summaries and source provenance.',
  },
  WorkspacePR: {
    category: 'history',
    handling: 'included',
    reason: 'PR associations and retained observations.',
  },
  WorkspacePRMonitoring: {
    category: 'config',
    handling: 'included',
    reason: 'Monitoring configuration restored disabled.',
  },
  WorkspacePRDedicatedSession: {
    category: 'config',
    handling: 'included',
    reason: 'Validated dedicated session bindings.',
  },
  WorkspacePREvent: {
    category: 'evidence',
    handling: 'included',
    reason: 'Delivery receipts and retained event evidence.',
  },
  WorkspacePRDiscovery: {
    category: 'cache',
    handling: 'included',
    reason: 'Discovery schedule; can be rebuilt from repository observations.',
  },
  WorkspaceRunScript: {
    category: 'runtime',
    handling: 'partial',
    reason: 'Commands retained; process IDs, ports and running state cleared.',
  },
  CodexAccount: {
    category: 'config',
    handling: 'partial',
    reason: 'Identity metadata remapped by verified scope; no homes or credentials.',
  },
  AgentSession: {
    category: 'history',
    handling: 'partial',
    reason: 'Session metadata only; provider history and running processes excluded.',
  },
  TerminalSession: {
    category: 'runtime',
    handling: 'partial',
    reason: 'Labels retained; processes and terminal contents excluded.',
  },
  UserSettings: {
    category: 'config',
    handling: 'partial',
    reason: 'Preferences only; encryption keys, API keys and rebuildable caches excluded.',
  },
  PeriodicTask: {
    category: 'config',
    handling: 'included',
    reason: 'Schedule definition restored disabled.',
  },
  PeriodicTaskExecution: {
    category: 'history',
    handling: 'included',
    reason: 'History; unfinished executions failed for explicit review, never relaunched.',
  },
  AgentDefinition: {
    category: 'config',
    handling: 'included',
    reason: 'Saved instructions and execution config restored disabled.',
  },
  AgentConnection: {
    category: 'config',
    handling: 'partial',
    reason: 'Provider identity restored disabled; encrypted credentials excluded.',
  },
  AgentTrigger: {
    category: 'config',
    handling: 'included',
    reason: 'Definitions restored paused with activation boundaries cleared.',
  },
  DecisionLog: {
    category: 'history',
    handling: 'excluded',
    reason: 'Not yet supported by logical recovery; retain full database backup.',
  },
  WorkspaceLaunchOrigin: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting durable provenance integration.',
  },
  WorkspaceChildOrigin: {
    category: 'evidence',
    handling: 'partial',
    reason:
      'Live imported hierarchy reconstructed; deleted-child history requires provenance integration.',
  },
  AgentSessionLaunchOrigin: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting durable run provenance integration.',
  },
  SessionLifecycleEvent: {
    category: 'history',
    handling: 'excluded',
    reason: 'Awaiting durable history integration.',
  },
  ClosedSession: {
    category: 'history',
    handling: 'excluded',
    reason: 'Awaiting archive packaging contract; metadata alone cannot recover transcript files.',
  },
  WorkspaceNotification: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting inert notification import; never replay queued sends implicitly.',
  },
  AgentRun: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting run-context/effect-proof foundation integration.',
  },
  AgentProposal: {
    category: 'config',
    handling: 'excluded',
    reason: 'Awaiting proposal and accepted-definition provenance integration.',
  },
  AgentSourceState: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting source checkpoint foundation integration.',
  },
  AgentSourcePage: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting source checkpoint foundation integration.',
  },
  AgentSourceBaseline: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting source checkpoint foundation integration.',
  },
  AgentEvent: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting retained event ledger integration.',
  },
  AgentEvaluation: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting retained evaluation/provenance integration.',
  },
  AgentInitialDelivery: {
    category: 'evidence',
    handling: 'excluded',
    reason: 'Awaiting inert effect-proof restore; missing proof never permits resend.',
  },
} as const satisfies Record<PrismaModelName, Coverage>;

export function recoveryManifest() {
  return {
    version: 1 as const,
    kind: 'logical' as const,
    models: recoveryModelCoverage,
    limitations: [
      'This is a limited logical export, not a full installation backup.',
      'Repository/worktree files, native account homes, credentials, encryption keys and provider-owned history are not included.',
      'A supported full backup retains the complete database and encryption.key together, plus any separately stored files needed for recovery.',
      'Imported automation is inactive. Missing or ambiguous effect evidence never authorizes a resend.',
    ],
  };
}
