import type { Agent, Mail, Project, Task } from '@prisma-gen/client';
import {
  AgentType,
  type CliProcessStatus,
  DesiredExecutionState,
  ExecutionState,
  TaskState,
} from '@prisma-gen/client';

let idCounter = 0;

function generateId(): string {
  return `test-id-${++idCounter}`;
}

export interface ProjectOverrides {
  id?: string;
  name?: string;
  slug?: string;
  repoPath?: string;
  worktreeBasePath?: string;
  defaultBranch?: string;
  githubOwner?: string | null;
  githubRepo?: string | null;
  isArchived?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export function createProject(overrides: ProjectOverrides = {}): Project {
  const id = overrides.id ?? generateId();
  const now = new Date();
  return {
    id,
    name: overrides.name ?? `Test Project ${id}`,
    slug: overrides.slug ?? `test-project-${id}`,
    repoPath: overrides.repoPath ?? `/tmp/repos/${id}`,
    worktreeBasePath: overrides.worktreeBasePath ?? `/tmp/worktrees/${id}`,
    defaultBranch: overrides.defaultBranch ?? 'main',
    githubOwner: overrides.githubOwner ?? null,
    githubRepo: overrides.githubRepo ?? null,
    isArchived: overrides.isArchived ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export interface TaskOverrides {
  id?: string;
  projectId?: string;
  parentId?: string | null;
  title?: string;
  description?: string | null;
  state?: TaskState;
  assignedAgentId?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  attempts?: number;
  failureReason?: string | null;
  lastReconcileAt?: Date | null;
  reconcileFailures?: object[];
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date | null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: factory function with many default fields
export function createTask(overrides: TaskOverrides = {}): Task {
  const id = overrides.id ?? generateId();
  const now = new Date();
  const parentId = overrides.parentId;
  // Top-level tasks (parentId undefined or null) start in PLANNING, subtasks start in PENDING
  const defaultState =
    parentId === undefined || parentId === null ? TaskState.PLANNING : TaskState.PENDING;

  return {
    id,
    projectId: overrides.projectId ?? generateId(),
    parentId: parentId ?? null,
    title: overrides.title ?? `Test Task ${id}`,
    description: overrides.description ?? null,
    state: overrides.state ?? defaultState,
    assignedAgentId: overrides.assignedAgentId ?? null,
    branchName: overrides.branchName ?? null,
    prUrl: overrides.prUrl ?? null,
    attempts: overrides.attempts ?? 0,
    failureReason: overrides.failureReason ?? null,
    lastReconcileAt: overrides.lastReconcileAt ?? null,
    reconcileFailures: overrides.reconcileFailures ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? null,
  };
}

export interface AgentOverrides {
  id?: string;
  type?: AgentType;
  executionState?: ExecutionState;
  desiredExecutionState?: DesiredExecutionState;
  currentTaskId?: string | null;
  tmuxSessionName?: string | null;
  sessionId?: string | null;
  worktreePath?: string | null;
  lastHeartbeat?: Date | null;
  lastReconcileAt?: Date | null;
  reconcileFailures?: object[];
  cliProcessId?: string | null;
  cliProcessStatus?: CliProcessStatus | null;
  cliProcessStartedAt?: Date | null;
  cliProcessExitCode?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: factory function with many default fields
export function createAgent(overrides: AgentOverrides = {}): Agent {
  const id = overrides.id ?? generateId();
  const now = new Date();
  return {
    id,
    type: overrides.type ?? AgentType.WORKER,
    executionState: overrides.executionState ?? ExecutionState.IDLE,
    desiredExecutionState: overrides.desiredExecutionState ?? DesiredExecutionState.IDLE,
    currentTaskId: overrides.currentTaskId ?? null,
    tmuxSessionName: overrides.tmuxSessionName ?? null,
    sessionId: overrides.sessionId ?? null,
    worktreePath: overrides.worktreePath ?? null,
    lastHeartbeat: overrides.lastHeartbeat ?? now,
    lastReconcileAt: overrides.lastReconcileAt ?? null,
    reconcileFailures: overrides.reconcileFailures ?? [],
    cliProcessId: overrides.cliProcessId ?? null,
    cliProcessStatus: overrides.cliProcessStatus ?? null,
    cliProcessStartedAt: overrides.cliProcessStartedAt ?? null,
    cliProcessExitCode: overrides.cliProcessExitCode ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export interface MailOverrides {
  id?: string;
  fromAgentId?: string | null;
  toAgentId?: string | null;
  isForHuman?: boolean;
  subject?: string;
  body?: string;
  isRead?: boolean;
  createdAt?: Date;
  readAt?: Date | null;
}

export function createMail(overrides: MailOverrides = {}): Mail {
  const id = overrides.id ?? generateId();
  const now = new Date();
  return {
    id,
    fromAgentId: overrides.fromAgentId ?? null,
    toAgentId: overrides.toAgentId ?? null,
    isForHuman: overrides.isForHuman ?? false,
    subject: overrides.subject ?? `Test Subject ${id}`,
    body: overrides.body ?? `Test body content for mail ${id}`,
    isRead: overrides.isRead ?? false,
    createdAt: overrides.createdAt ?? now,
    readAt: overrides.readAt ?? null,
  };
}
