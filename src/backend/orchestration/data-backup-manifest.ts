import { ApplicationError } from '@/backend/lib/application-error';
import { validateRecoverySourceProof } from '@/backend/services/agent-definition';
import { prismaModelNames, type PrismaModelName } from '@/backend/services/registry';
import { validateRecoveryIdentityUniqueness } from '@/backend/services/settings';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import { validateRecoveryGraph } from './data-backup-graph-validation';
import { validateRecoveryJsonStorage } from './data-backup-json-storage';

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
  WorkspacePRDelivery: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Exact ordered receipt membership and frozen proof in normalized snapshot; unresolved effects restore BLOCKED without flattening.',
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
    reason:
      'Definitions restored paused; original boundary and pending-control evidence retained without activating it.',
  },
  DecisionLog: {
    category: 'history',
    handling: 'included',
    reason: 'Historical decisions and reasoning retained independently of runtime processes.',
  },
  WorkspaceLaunchOrigin: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Retained workspace/run creation provenance; colliding target identities never borrowed.',
  },
  WorkspaceChildOrigin: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Live and deleted child creation identities retained; incomplete imported graphs cannot certify child coverage.',
  },
  AgentSessionLaunchOrigin: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Retained immutable run/session launch intent with original external account identity; operational session accounts map separately.',
  },
  SessionLifecycleEvent: {
    category: 'history',
    handling: 'included',
    reason: 'Interrupted/stopped turn history and original deduplication identities retained.',
  },
  ChatIntent: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Submitted bytes and desired settings revisions retained; queued imports fail closed without enqueueing.',
  },
  PromptDispatchAttempt: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Frozen ordered membership, provider identity and evidence retained; uncertain effects remain held.',
  },
  AgentSourceCheckpoint: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Validated compact checkpoint proof; unfinished validation progress restarts under disabled intake.',
  },
  AgentSourceHead: {
    category: 'evidence',
    handling: 'included',
    reason: 'Exact historical head-to-ordinal identities retained.',
  },
  ClosedSession: {
    category: 'history',
    handling: 'included',
    reason:
      'Exact archive identity and checksum bytes; imported pending payloads publish through recoverable app-owned storage.',
  },
  WorkspaceNotification: {
    category: 'evidence',
    handling: 'partial',
    reason:
      'Message intent and real delivery timestamps retained. Pending imports explicitly held; no automatic send or fabricated delivery.',
  },
  AgentRun: {
    category: 'evidence',
    handling: 'partial',
    reason:
      'Frozen snapshots, result and reservations retained; unresolved status explicitly imported for review with no automatic execution. Frozen account identity is retained; operational session FKs map separately.',
  },
  AgentProposal: {
    category: 'config',
    handling: 'included',
    reason:
      'Draft specification and accepted-definition provenance retained for imported parent graphs.',
  },
  AgentSourceState: {
    category: 'evidence',
    handling: 'included',
    reason: 'Cursor and continuity metadata retained; imported intake remains unready.',
  },
  AgentSourcePage: {
    category: 'evidence',
    handling: 'included',
    reason: 'Exact source/control identity evidence and ordinal records retained.',
  },
  AgentSourceBaseline: {
    category: 'evidence',
    handling: 'included',
    reason: 'Existing issued baseline identities and finalized ordinal markers retained.',
  },
  AgentEvent: {
    category: 'evidence',
    handling: 'included',
    reason: 'Retained normalized event identities and nullable expired payloads.',
  },
  AgentEvaluation: {
    category: 'evidence',
    handling: 'included',
    reason:
      'Frozen evaluation/configuration snapshots, classifier identity and run references retained; matched decisions awaiting admission are held for review and retry timers cleared.',
  },
  AgentInitialDelivery: {
    category: 'evidence',
    handling: 'partial',
    reason:
      'Full send/message identities and provider evidence retained; unfinished effects become ambiguous and are never replayed automatically.',
  },
} as const satisfies Record<PrismaModelName, Coverage>;

export function recoveryManifest() {
  return {
    version: 1 as const,
    kind: 'logical' as const,
    models: structuredClone(recoveryModelCoverage),
    limitations: [
      'This is a limited logical export, not a full installation backup.',
      'Repository/worktree contents, native account homes, credentials, encryption keys and provider-owned history are not included; captured closed-session transcript bytes are included.',
      'A supported full backup retains the complete database and encryption.key together, plus the app-owned closed-sessions directory and any legacy transcript files not yet relocated.',
      'Imported automation is inactive. Missing or ambiguous effect evidence never authorizes a resend.',
    ],
  };
}

export function validateRecoveryManifest(input: ExportData) {
  if (input.meta.schemaVersion !== 8) {
    if (input.data.durable || input.data.archives) {
      throw new ApplicationError('INVALID_INPUT', 'Durable recovery requires schema version 8');
    }
    return;
  }
  validateRecoveryIdentityUniqueness(input.data);
  validateRecoveryGraph(input.data);
  validateRecoveryJsonStorage(input.data);
  if (input.data.durable) {
    validateRecoverySourceProof(input.data.durable);
  }
  const declared = new Set(Object.keys(input.meta.recovery?.models ?? {}));
  if (
    declared.size !== prismaModelNames.length ||
    prismaModelNames.some((name) => !declared.has(name))
  ) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Logical recovery model coverage does not match the supported registry'
    );
  }
}
