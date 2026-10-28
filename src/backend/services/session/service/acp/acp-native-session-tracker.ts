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

export interface AcpBackgroundWork {
  backgroundTasks: { id: string; name: string; kind: 'shell' | 'turn' | 'task' }[];
  runningSubagents: number;
  activeGoals: number;
}

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
  name: z.string().optional(),
  taskType: z.string().optional(),
  state: z.enum(['running', 'paused', 'completed', 'failed', 'stopped']).optional(),
});

const MAX_CHILD_TRANSCRIPT_TURNS = 100;
const MAX_CHILD_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type TranscriptTurn = { updates: SubagentTranscriptUpdate[]; bytes: number };

type ChildSession = {
  parentSessionId: string;
  summary: SubagentSummary;
  turns: TranscriptTurn[];
  turnOffset: number;
  transcriptBytes: number;
  discardingTurn: boolean;
  previousUserChunk?: { messageId?: string | null };
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
  private readonly abandonedSessions = new Set<string>();
  private available = false;
  private readonly children = new Map<string, ChildSession>();
  private readonly activeTasks = new Map<
    string,
    { name: string; kind: AcpBackgroundWork['backgroundTasks'][number]['kind']; active: boolean }
  >();
  private readonly activeGoals = new Set<string>();
  private activityKey = JSON.stringify({
    backgroundTasks: [],
    runningSubagents: 0,
    activeGoals: 0,
  });

  constructor(private readonly callbacks: TrackerCallbacks = {}) {}

  setRootSessionId(sessionId: string): void {
    if (this.rootSessionId && this.rootSessionId !== sessionId) {
      this.resetSession();
    }
    this.abandonedSessions.delete(sessionId);
    this.rootSessionId = sessionId;
  }

  /** Discards abandoned load replay before a replacement session starts publishing. */
  resetSession(): void {
    if (this.rootSessionId) {
      this.abandonedSessions.add(this.rootSessionId);
    }
    for (const sessionId of this.children.keys()) {
      this.abandonedSessions.add(sessionId);
    }
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

  getBackgroundWork(): AcpBackgroundWork {
    return {
      backgroundTasks: [...this.activeTasks]
        .filter(([, task]) => task.active)
        .map(([id, { name, kind }]) => ({ id, name, kind })),
      runningSubagents: [...this.children.values()].filter(
        (child) => child.summary.status === 'running'
      ).length,
      activeGoals: this.activeGoals.size,
    };
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
    if (this.abandonedSessions.has(sessionId)) {
      return true;
    }
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
    const end = pageIndex(input.cursor, child.turnOffset + child.turns.length);
    if (input.cursor != null && child.turnOffset > 0 && end <= child.turnOffset) {
      throw new AcpSubagentBrowseError('INVALID_INPUT', 'Sub-agent pagination cursor has expired.');
    }
    const start = Math.max(child.turnOffset, end - input.limit);
    return {
      projectionBoundary: 'turn',
      updates: structuredClone(
        child.turns
          .slice(start - child.turnOffset, end - child.turnOffset)
          .flatMap((turn) => turn.updates)
      ),
      nextCursor: start > child.turnOffset ? String(start) : null,
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
    const child: ChildSession = {
      parentSessionId,
      turns: [],
      turnOffset: 0,
      transcriptBytes: 0,
      discardingTurn: false,
      pendingPrompt: false,
      summary: {
        id,
        name,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        latestActivity: task?.slice(-500) ?? null,
        resultPreview: null,
      },
    };
    if (prompt) {
      this.appendTurn(child, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: prompt },
      });
      child.pendingPrompt = true;
    }
    this.children.set(id, child);
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
    this.activeGoals.delete(child.summary.id);
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
      child.turnOffset = 0;
      child.transcriptBytes = 0;
      child.discardingTurn = false;
      child.previousUserChunk = undefined;
    }
    child.pendingPrompt = false;
    let turn = child.turns.at(-1);
    const user = value.sessionUpdate === 'user_message_chunk';
    const messageId = value.sessionUpdate === 'user_message_chunk' ? value.messageId : undefined;
    const sameUserMessage =
      child.previousUserChunk &&
      (!(messageId && child.previousUserChunk.messageId) ||
        messageId === child.previousUserChunk.messageId);
    child.previousUserChunk = user ? { messageId } : undefined;
    if (!(turn || child.discardingTurn) || (user && !sameUserMessage)) {
      turn = { updates: [], bytes: 0 };
      child.turns.push(turn);
      child.discardingTurn = false;
    }
    if (!turn || child.discardingTurn) {
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    turn.updates.push(value);
    turn.bytes += bytes;
    child.transcriptBytes += bytes;
    this.evictOldTurns(child, turn);
  }

  private evictOldTurns(child: ChildSession, currentTurn: TranscriptTurn): void {
    while (
      child.turns.length > MAX_CHILD_TRANSCRIPT_TURNS ||
      child.transcriptBytes > MAX_CHILD_TRANSCRIPT_BYTES
    ) {
      const oldest = child.turns.shift();
      if (!oldest) {
        break;
      }
      child.transcriptBytes -= oldest.bytes;
      child.turnOffset += 1;
      // Never retain a partial turn with orphaned tool results after its beginning was evicted.
      if (oldest === currentTurn) {
        child.discardingTurn = true;
      }
    }
  }

  private updateSummary(summary: SubagentSummary, value: SubagentTranscriptUpdate): void {
    summary.updatedAt = new Date().toISOString();
    if ('content' in value && record(value.content)?.type === 'text') {
      const text = record(value.content)?.text;
      if (typeof text === 'string') {
        if (text.trim()) {
          summary.latestActivity = text.slice(-500);
        }
        if (value.sessionUpdate === 'agent_message_chunk') {
          summary.resultPreview = `${summary.resultPreview ?? ''}${text}`.slice(-500);
        }
      }
    } else if ('title' in value && typeof value.title === 'string') {
      summary.latestActivity = value.title.slice(-500);
    }
  }

  private trackTask(sessionId: string, update: Record<string, unknown>): void {
    const parsed = taskSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const key = JSON.stringify([sessionId, parsed.data.asyncTaskId]);
    const previous = this.activeTasks.get(key);
    if (update.sessionUpdate === 'async_task_spawned' || parsed.data.state === 'running') {
      this.activeTasks.set(key, {
        name: parsed.data.name?.trim().slice(0, 500) || previous?.name || 'Background task',
        kind: previous?.kind ?? taskKind(parsed.data.taskType),
        active: true,
      });
    } else if (parsed.data.state === 'paused' && previous) {
      this.activeTasks.set(key, { ...previous, active: false });
    } else if (update.sessionUpdate === 'async_task_state_update' && parsed.data.state) {
      this.activeTasks.delete(key);
    }
    this.publishActivity();
  }

  private publishActivity(): void {
    const work = this.getBackgroundWork();
    const activityKey = JSON.stringify(work);
    const active =
      work.activeGoals > 0 || work.backgroundTasks.length > 0 || work.runningSubagents > 0;
    if (activityKey === this.activityKey) {
      return;
    }
    this.activityKey = activityKey;
    this.callbacks.onTaskStatusChanged?.(active);
  }

  private changed(subagentId: string, change: SubagentsChangedParams['change']): void {
    if (this.rootSessionId) {
      this.callbacks.onSubagentsChanged?.({ sessionId: this.rootSessionId, subagentId, change });
    }
  }
}

function taskKind(taskType?: string): AcpBackgroundWork['backgroundTasks'][number]['kind'] {
  if (taskType === 'shell' || taskType === 'local_bash') {
    return 'shell';
  }
  return taskType === 'turn' ? 'turn' : 'task';
}
