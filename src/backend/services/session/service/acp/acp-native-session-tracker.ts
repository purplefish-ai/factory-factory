import { z } from 'zod';
import {
  type SubagentListResult,
  type SubagentReadResult,
  type SubagentSummary,
  type SubagentTranscriptUpdate,
  type SubagentsChangedParams,
  subagentTranscriptUpdateSchema,
} from '@/shared/acp-protocol/subagents';
import { AcpSubagentBrowseError } from './acp-runtime-errors';
import { normalizeSessionUpdateMessage } from './acp-stream-normalizer';

const spawnedSchema = z.object({
  subagentSessionId: z.string().min(1),
  name: z.string(),
  task: z.string().optional(),
  prompt: z.string().optional(),
});
const stateSchema = z.object({
  subagentSessionId: z.string().min(1),
  state: z.enum(['completed', 'failed', 'cancelled', 'disconnected']),
});
const taskSchema = z.object({
  asyncTaskId: z.string().min(1),
  state: z.enum(['running', 'paused', 'completed', 'failed', 'stopped']).optional(),
});

type ChildSession = {
  parentSessionId: string;
  summary: SubagentSummary;
  turns: SubagentTranscriptUpdate[][];
  pendingPrompt: boolean;
};

type TrackerCallbacks = {
  onSubagentsChanged?: (params: SubagentsChangedParams) => void;
  onTaskStatusChanged?: (active: boolean) => void;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function airMetadata(update: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(record(update._meta)?.jetbrains)?.air);
}

function pageIndex(cursor: string | null | undefined, fallback: number): number {
  if (cursor == null) {
    return fallback;
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new AcpSubagentBrowseError('INVALID_INPUT', 'Invalid sub-agent pagination cursor.');
  }
  const index = Number(cursor);
  if (!Number.isSafeInteger(index) || index > fallback) {
    throw new AcpSubagentBrowseError('INVALID_INPUT', 'Invalid sub-agent pagination cursor.');
  }
  return index;
}

/** Keeps draft native updates out of the released SDK and out of the parent transcript. */
export class AcpNativeSessionTracker {
  private rootSessionId?: string;
  private available = false;
  private readonly children = new Map<string, ChildSession>();
  private readonly activeTasks = new Set<string>();
  private readonly activeGoals = new Set<string>();
  private active = false;

  constructor(private readonly callbacks: TrackerCallbacks = {}) {}

  setRootSessionId(sessionId: string): void {
    if (this.rootSessionId && this.rootSessionId !== sessionId) {
      this.resetSession();
    }
    this.rootSessionId = sessionId;
  }

  /** Discards abandoned load replay before a replacement session starts publishing. */
  resetSession(): void {
    this.rootSessionId = undefined;
    this.children.clear();
    this.activeTasks.clear();
    this.activeGoals.clear();
    this.publishActivity();
  }

  setCapabilities(capabilities: Record<string, unknown>): void {
    if (record(record(capabilities.sessionCapabilities)?.subagents)) {
      this.available = true;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  ownsSession(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  /** Returns true only when the decoded notification must not be passed to SDK validation. */
  onRawMessage(message: unknown): boolean {
    const envelope = record(normalizeSessionUpdateMessage(message));
    if (!envelope) {
      return false;
    }
    const capabilities = record(record(envelope.result)?.agentCapabilities);
    if (capabilities) {
      this.setCapabilities(capabilities);
    }
    if (envelope.method !== 'session/update') {
      return false;
    }
    const params = record(envelope.params);
    const update = record(params?.update);
    if (!(params && update) || typeof params.sessionId !== 'string') {
      return false;
    }
    return this.handleSessionUpdate(params.sessionId, update);
  }

  private handleSessionUpdate(sessionId: string, update: Record<string, unknown>): boolean {
    // Providers publish the parent spawn before any child output, including on load.
    this.rootSessionId ??= sessionId;
    if (this.consumeLifecycleUpdate(sessionId, update)) {
      return true;
    }
    if (sessionId === this.rootSessionId) {
      this.trackGoal(sessionId, update);
      return false;
    }
    const child = this.children.get(sessionId);
    if (child) {
      this.trackGoal(sessionId, update);
      this.append(child, update);
    }
    // Never let a foreign session's updates contaminate the root, even if its spawn was malformed.
    return true;
  }

  private consumeLifecycleUpdate(sessionId: string, update: Record<string, unknown>): boolean {
    const kind = update.sessionUpdate;
    const nativeLifecycle =
      kind === 'subagent_spawned' ||
      kind === 'subagent_state_update' ||
      (typeof kind === 'string' && kind.startsWith('async_task_'));
    if (!nativeLifecycle) {
      return false;
    }
    if (sessionId !== this.rootSessionId && !this.ownsSession(sessionId)) {
      return true;
    }
    switch (kind) {
      case 'subagent_spawned':
        this.spawn(sessionId, update);
        break;
      case 'subagent_state_update':
        this.finish(sessionId, update);
        break;
      default:
        this.trackTask(sessionId, update);
    }
    return true;
  }

  private trackGoal(sessionId: string, update: Record<string, unknown>): void {
    if (update.sessionUpdate !== 'session_info_update') {
      return;
    }
    const air = airMetadata(update);
    if (!(air && Object.hasOwn(air, 'goal'))) {
      return;
    }
    if (record(air.goal)?.status === 'active') {
      this.activeGoals.add(sessionId);
    } else {
      this.activeGoals.delete(sessionId);
    }
    this.publishActivity();
  }

  list(input: { cursor?: string | null; limit: number }): SubagentListResult {
    const children = [...this.children.values()];
    const start = pageIndex(input.cursor, children.length);
    const offset = input.cursor == null ? 0 : start;
    const end = Math.min(offset + input.limit, children.length);
    return {
      subagents: children.slice(offset, end).map((child) => ({ ...child.summary })),
      nextCursor: end < children.length ? String(end) : null,
    };
  }

  read(input: { subagentId: string; cursor?: string | null; limit: number }): SubagentReadResult {
    const child = this.children.get(input.subagentId);
    if (!child) {
      throw new AcpSubagentBrowseError(
        'NOT_FOUND',
        'Sub-agent transcript not found for this session.'
      );
    }
    const end = pageIndex(input.cursor, child.turns.length);
    const start = Math.max(0, end - input.limit);
    return {
      projectionBoundary: 'turn',
      updates: structuredClone(child.turns.slice(start, end).flat()),
      nextCursor: start > 0 ? String(start) : null,
    };
  }

  private spawn(parentSessionId: string, update: Record<string, unknown>): void {
    const parsed = spawnedSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const { subagentSessionId: id, name, task, prompt } = parsed.data;
    if (id === this.rootSessionId || id === parentSessionId || this.children.has(id)) {
      return;
    }
    const now = new Date().toISOString();
    this.children.set(id, {
      parentSessionId,
      turns: prompt
        ? [[{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } }]]
        : [],
      pendingPrompt: Boolean(prompt),
      summary: {
        id,
        name,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        latestActivity: task ?? null,
        resultPreview: null,
      },
    });
    this.changed(id, 'created');
    this.publishActivity();
  }

  private finish(parentSessionId: string, update: Record<string, unknown>): void {
    const parsed = stateSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const child = this.children.get(parsed.data.subagentSessionId);
    if (!child || child.parentSessionId !== parentSessionId) {
      return;
    }
    child.summary.status = parsed.data.state === 'disconnected' ? 'interrupted' : parsed.data.state;
    child.summary.updatedAt = new Date().toISOString();
    child.summary.completedAt = child.summary.updatedAt;
    this.changed(child.summary.id, 'completed');
    this.publishActivity();
  }

  private append(child: ChildSession, update: Record<string, unknown>): void {
    const parsed = subagentTranscriptUpdateSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const value = parsed.data;
    this.appendTurn(child, value);
    this.updateSummary(child.summary, value);
    this.changed(child.summary.id, 'updated');
  }

  private appendTurn(child: ChildSession, value: SubagentTranscriptUpdate): void {
    if (child.pendingPrompt && value.sessionUpdate === 'user_message_chunk') {
      child.turns = [];
    }
    child.pendingPrompt = false;
    let turn = child.turns.at(-1);
    const previous = turn?.at(-1);
    const user = value.sessionUpdate === 'user_message_chunk';
    const messageId = 'messageId' in value ? value.messageId : undefined;
    const sameUserMessage =
      previous?.sessionUpdate === 'user_message_chunk' &&
      (!(messageId && previous.messageId) || messageId === previous.messageId);
    if (!turn || (user && !sameUserMessage)) {
      turn = [];
      child.turns.push(turn);
    }
    turn.push(value);
  }

  private updateSummary(summary: SubagentSummary, value: SubagentTranscriptUpdate): void {
    summary.updatedAt = new Date().toISOString();
    if ('content' in value && record(value.content)?.type === 'text') {
      const text = record(value.content)?.text;
      if (typeof text === 'string' && text.trim()) {
        summary.latestActivity = text.slice(-500);
        if (value.sessionUpdate === 'agent_message_chunk') {
          summary.resultPreview = text.slice(-500);
        }
      }
    } else if ('title' in value && typeof value.title === 'string') {
      summary.latestActivity = value.title;
    }
  }

  private trackTask(sessionId: string, update: Record<string, unknown>): void {
    const parsed = taskSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const key = JSON.stringify([sessionId, parsed.data.asyncTaskId]);
    if (update.sessionUpdate === 'async_task_spawned' || parsed.data.state === 'running') {
      this.activeTasks.add(key);
    } else if (update.sessionUpdate === 'async_task_state_update' && parsed.data.state) {
      this.activeTasks.delete(key);
    }
    this.publishActivity();
  }

  private publishActivity(): void {
    const active =
      this.activeGoals.size > 0 ||
      this.activeTasks.size > 0 ||
      [...this.children.values()].some((child) => child.summary.status === 'running');
    if (active === this.active) {
      return;
    }
    this.active = active;
    this.callbacks.onTaskStatusChanged?.(active);
  }

  private changed(subagentId: string, change: SubagentsChangedParams['change']): void {
    if (this.rootSessionId) {
      this.callbacks.onSubagentsChanged?.({ sessionId: this.rootSessionId, subagentId, change });
    }
  }
}
