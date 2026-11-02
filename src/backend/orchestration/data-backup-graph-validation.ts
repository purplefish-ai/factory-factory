import { ApplicationError } from '@/backend/lib/application-error';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import type { ExportData } from '@/shared/schemas/export-data.schema';

type Data = ExportData['data'];
function invalid(detail: string): never {
  throw new ApplicationError('INVALID_INPUT', `Invalid recovery graph: ${detail}`);
}
function index<T extends { id: string | number }>(rows: readonly T[], model: string) {
  const result = new Map<string | number, T>();
  for (const row of rows) {
    if (result.has(row.id)) {
      invalid(`duplicate ${model} identity ${row.id}`);
    }
    result.set(row.id, row);
  }
  return result;
}
function required<T>(rows: ReadonlyMap<string | number, T>, id: string | number, field: string): T {
  const row = rows.get(id);
  if (!row) {
    invalid(`missing required parent ${field}: ${id}`);
  }
  return row;
}
function optional<T>(rows: ReadonlyMap<string | number, T>, id: string | null, field: string) {
  return id === null ? undefined : required(rows, id, field);
}
function same(actual: string, expected: string, field: string) {
  if (actual !== expected) {
    invalid(`foreign required parent ${field}`);
  }
}
function owners(data: Data, durable: DurableRecovery) {
  return {
    projects: index(data.projects, 'Project'),
    workspaces: index(data.workspaces, 'Workspace'),
    sessions: index(data.agentSessions, 'AgentSession'),
    accounts: index(data.codexAccounts, 'CodexAccount'),
    tasks: index(durable.periodicTask, 'PeriodicTask'),
    definitions: index(durable.agentDefinition, 'AgentDefinition'),
    connections: index(durable.agentConnection, 'AgentConnection'),
    triggers: index(durable.agentTrigger, 'AgentTrigger'),
    events: index(durable.agentEvent, 'AgentEvent'),
    runs: index(durable.agentRun, 'AgentRun'),
    attempts: index(durable.promptDispatchAttempt, 'PromptDispatchAttempt'),
  };
}
type Owners = ReturnType<typeof owners>;

function validateWorkspaceGraph(data: Data, graph: Owners) {
  for (const workspace of data.workspaces) {
    required(graph.projects, workspace.projectId, 'Workspace.projectId');
    optional(graph.workspaces, workspace.parentWorkspaceId, 'Workspace.parentWorkspaceId');
    const task = optional(graph.tasks, workspace.periodicTaskId, 'Workspace.periodicTaskId');
    if (task) {
      same(task.projectId, workspace.projectId, 'Workspace.periodicTaskId');
    }
  }
  validateAncestry(graph);
  for (const session of data.agentSessions) {
    required(graph.workspaces, session.workspaceId, 'AgentSession.workspaceId');
    optional(graph.accounts, session.codexAccountId, 'AgentSession.codexAccountId');
  }
  for (const session of data.terminalSessions) {
    required(graph.workspaces, session.workspaceId, 'TerminalSession.workspaceId');
  }
  for (const archive of data.archives?.entries ?? []) {
    required(graph.workspaces, archive.workspaceId, 'ClosedSession.workspaceId');
  }
}
function validateAncestry(graph: Owners) {
  const checked = new Set<string>();
  for (const workspace of graph.workspaces.values()) {
    const path = new Set<string>();
    let ancestor: typeof workspace | undefined = workspace;
    while (ancestor && !checked.has(ancestor.id)) {
      if (path.has(ancestor.id)) {
        invalid('workspace ancestry cycle');
      }
      path.add(ancestor.id);
      ancestor = optional(
        graph.workspaces,
        ancestor.parentWorkspaceId,
        'Workspace.parentWorkspaceId'
      );
    }
    for (const id of path) {
      checked.add(id);
    }
  }
}

function validateAutomationGraph(data: DurableRecovery, graph: Owners) {
  for (const task of data.periodicTask) {
    required(graph.projects, task.projectId, 'PeriodicTask.projectId');
  }
  for (const execution of data.periodicTaskExecution) {
    const task = required(
      graph.tasks,
      execution.periodicTaskId,
      'PeriodicTaskExecution.periodicTaskId'
    );
    const workspace = optional(
      graph.workspaces,
      execution.workspaceId,
      'PeriodicTaskExecution.workspaceId'
    );
    if (workspace) {
      same(workspace.projectId, task.projectId, 'PeriodicTaskExecution.workspaceId');
    }
  }
  for (const definition of data.agentDefinition) {
    required(graph.projects, definition.projectId, 'AgentDefinition.projectId');
  }
  for (const trigger of data.agentTrigger) {
    required(graph.definitions, trigger.agentDefinitionId, 'AgentTrigger.agentDefinitionId');
    optional(graph.connections, trigger.connectionId, 'AgentTrigger.connectionId');
  }
  for (const proposal of data.agentProposal) {
    const workspace = required(graph.workspaces, proposal.workspaceId, 'AgentProposal.workspaceId');
    const definition = optional(
      graph.definitions,
      proposal.agentDefinitionId,
      'AgentProposal.agentDefinitionId'
    );
    if (definition) {
      same(definition.projectId, workspace.projectId, 'AgentProposal.agentDefinitionId');
    }
  }
}
function validateRunGraph(data: DurableRecovery, graph: Owners) {
  for (const run of data.agentRun) {
    const definition = required(
      graph.definitions,
      run.agentDefinitionId,
      'AgentRun.agentDefinitionId'
    );
    const trigger = optional(graph.triggers, run.triggerId, 'AgentRun.triggerId');
    if (trigger) {
      same(trigger.agentDefinitionId, run.agentDefinitionId, 'AgentRun.triggerId');
    }
    optional(graph.events, run.eventId, 'AgentRun.eventId');
    const workspace = optional(graph.workspaces, run.workspaceId, 'AgentRun.workspaceId');
    if (workspace) {
      same(workspace.projectId, definition.projectId, 'AgentRun.workspaceId');
    }
  }
  for (const evaluation of data.agentEvaluation) {
    const event = required(graph.events, evaluation.eventId, 'AgentEvaluation.eventId');
    same(event.connectionId, evaluation.connectionId, 'AgentEvaluation.connectionId');
    required(graph.definitions, evaluation.agentDefinitionId, 'AgentEvaluation.agentDefinitionId');
    const trigger = required(graph.triggers, evaluation.triggerId, 'AgentEvaluation.triggerId');
    same(trigger.agentDefinitionId, evaluation.agentDefinitionId, 'AgentEvaluation.triggerId');
    const run = optional(graph.runs, evaluation.runId, 'AgentEvaluation.runId');
    if (run) {
      same(run.agentDefinitionId, evaluation.agentDefinitionId, 'AgentEvaluation.runId');
      if (run.eventId !== evaluation.eventId) {
        invalid('foreign required parent AgentEvaluation.runId/eventId');
      }
    }
  }
  for (const delivery of data.agentInitialDelivery) {
    required(graph.runs, delivery.runId, 'AgentInitialDelivery.runId');
  }
}
function validateSourceGraph(data: DurableRecovery, graph: Owners) {
  const states = new Map(data.agentSourceState.map((row) => [row.connectionId, row]));
  const checkpoints = new Map(
    data.agentSourceCheckpoint.map((row) => [JSON.stringify([row.connectionId, row.scanId]), row])
  );
  for (const state of data.agentSourceState) {
    required(graph.connections, state.connectionId, 'AgentSourceState.connectionId');
  }
  for (const row of [
    ...data.agentSourcePage,
    ...data.agentSourceBaseline,
    ...data.agentSourceCheckpoint,
  ]) {
    required(states, row.connectionId, 'SourceProof.connectionId');
  }
  for (const head of data.agentSourceHead) {
    required(
      checkpoints,
      JSON.stringify([head.connectionId, head.scanId]),
      'AgentSourceHead.checkpoint'
    );
  }
  for (const event of data.agentEvent) {
    required(graph.connections, event.connectionId, 'AgentEvent.connectionId');
  }
}
function validateSessionGraph(data: DurableRecovery, graph: Owners) {
  for (const attempt of data.promptDispatchAttempt) {
    required(graph.sessions, attempt.sessionId, 'PromptDispatchAttempt.sessionId');
  }
  for (const intent of data.chatIntent) {
    required(graph.sessions, intent.sessionId, 'ChatIntent.sessionId');
    const attempt = optional(graph.attempts, intent.attemptId, 'ChatIntent.attemptId');
    if (attempt) {
      same(attempt.sessionId, intent.sessionId, 'ChatIntent.attemptId');
    }
  }
  for (const row of [...data.workspaceNotification, ...data.sessionLifecycleEvent]) {
    required(graph.workspaces, row.workspaceId, 'RetainedHistory.workspaceId');
  }
  for (const event of data.sessionLifecycleEvent) {
    // Session IDs are retained after deletion, but a surviving package session
    // must agree with the event's workspace ownership.
    const session = graph.sessions.get(event.sessionId);
    if (session) {
      same(session.workspaceId, event.workspaceId, 'SessionLifecycleEvent.sessionId');
    }
  }
}

/** Actual foreign keys must be closed within the package. Non-FK retained origins,
 * deleted child/session identities and generic decision tags intentionally may outlive owners.
 * Destination collisions are a separate, reported additive-import policy.
 */
export function validateRecoveryGraph(data: Data): void {
  if (!data.durable) {
    invalid('missing durable recovery');
  }
  const graph = owners(data, data.durable);
  validateWorkspaceGraph(data, graph);
  validateAutomationGraph(data.durable, graph);
  validateRunGraph(data.durable, graph);
  validateSourceGraph(data.durable, graph);
  validateSessionGraph(data.durable, graph);
}
