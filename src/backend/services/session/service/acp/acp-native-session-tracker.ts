import { z } from 'zod';
import type { SessionStopTarget, AcpBackgroundTask } from '@/shared/acp-protocol/subagents';
import {
  type SubagentListResult,
  type SubagentReadResult,
  type SubagentSummary,
  type SubagentTranscriptUpdate,
  type SubagentsChangedParams,
  subagentTranscriptUpdateSchema,
  getSubagentThreadId,
} from '@/shared/acp-protocol/subagents';
import { AcpSubagentBrowseError } from './acp-runtime-errors';
import { normalizeSessionUpdateMessage } from './acp-stream-normalizer';
import { AcpTargetedStopControls, type AcpStopDispatch } from './acp-targeted-stop-controls';

export interface AcpBackgroundWork {
  backgroundTasks: AcpBackgroundTask[];
  runningSubagents: number;
  activeGoals: number;
}

const spawnedSchema = z.object({
  subagentSessionId: z.string().min(1),
  name: z.string(),
  task: z.string().optional(),
  prompt: z.string().optional(),
  capabilities: z.object({ cancel: z.record(z.string(), z.unknown()).nullish() }).optional(),
});
const stateSchema = z.object({
  subagentSessionId: z.string().min(1),
  state: z.enum(['completed', 'failed', 'cancelled', 'disconnected']),
});
const taskSchema = z.object({
  asyncTaskId: z.string().min(1),
  canStop: z.boolean().optional(),
  name: z.string().optional(),
  taskType: z.string().optional(),
  state: z.enum(['running', 'paused', 'completed', 'failed', 'stopped']).optional(),
});

const MAX_CHILD_TRANSCRIPT_TURNS = 100;
const MAX_CHILD_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type TranscriptTurn = { updates: SubagentTranscriptUpdate[]; bytes: number };

type ChildSession = {
  parentSessionId: string;
  activeSessionId: string;
  startNewTurn: boolean;
  generationOffset: number;
  replayed: boolean;
  summary: SubagentSummary;
  turns: TranscriptTurn[];
  turnOffset: number;
  transcriptBytes: number;
  discardingTurn: boolean;
  previousUserChunk?: { messageId?: string | null };
  pendingPrompt: boolean;
};

export type SubagentToolUpdate = Extract<
  SubagentTranscriptUpdate,
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>;

type TrackerCallbacks = {
  /** Codex resumes one thread under successive native generation IDs. */
  groupCodexGenerations?: boolean;
  onSubagentsChanged?: (params: SubagentsChangedParams) => void;
  onTaskStatusChanged?: (active: boolean) => void;
  /** Child tool activity stays out of the parent transcript but still reaches observers. */
  onSubagentToolUpdate?: (subagentId: string, update: SubagentToolUpdate) => void;
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
  private readonly stopControls = new AcpTargetedStopControls();
  private readonly abandonedSessions = new Set<string>();
  private available = false;
  private replayingHistory = false;
  private workRevision = 0;
  private coverageGeneration = 0;
  private preserveReplayShellTasks = false;
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

  beginHistoryReplay(preserveShellTasks = false): void {
    this.coverageGeneration++;
    this.workRevision++;
    this.stopControls.clear();
    this.replayingHistory = true;
    this.preserveReplayShellTasks = preserveShellTasks;
  }

  /** Replayed work is historical unless the adapter has independently reconciled it. */
  completeHistoryReplay(): void {
    if (!this.replayingHistory) {
      return;
    }
    for (const [id, task] of this.activeTasks) {
      // Codex only announces shell tasks recovered from its live terminal listing.
      if (!(this.preserveReplayShellTasks && task.kind === 'shell')) {
        this.activeTasks.delete(id);
      }
    }
    this.activeGoals.clear();
    for (const child of this.children.values()) {
      child.replayed = true;
      if (child.summary.status === 'running') {
        child.summary.status = 'interrupted';
        // Replay completion proves interruption, not when the historical work ended.
        child.summary.completedAt = null;
        this.changed(child.summary.id, 'completed');
      }
    }
    this.replayingHistory = false;
    this.publishActivity();
  }

  /** Discards abandoned load replay before a replacement session starts publishing. */
  resetSession(): void {
    this.coverageGeneration++;
    this.workRevision++;
    if (this.rootSessionId) {
      this.abandonedSessions.add(this.rootSessionId);
    }
    for (const sessionId of this.children.keys()) {
      this.abandonedSessions.add(sessionId);
    }
    this.stopControls.clear();
    this.rootSessionId = undefined;
    this.replayingHistory = false;
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
    if (this.replayingHistory) {
      return { backgroundTasks: [], runningSubagents: 0, activeGoals: 0 };
    }
    return {
      backgroundTasks: [...this.activeTasks]
        .filter(([, task]) => task.active)
        .map(([id, { name, kind }]) => ({ id, name, kind, ...this.controlFields('task', id) })),
      runningSubagents: [...this.children.values()].filter(
        (child) => child.summary.status === 'running'
      ).length,
      activeGoals: this.activeGoals.size,
    };
  }

  /** Live tracking facts, separate from presentation defaults during history replay. */
  getWorkObservation() {
    return {
      revision: this.workRevision,
      coverageGeneration: this.coverageGeneration,
      replaying: this.replayingHistory,
      rootSessionId: this.rootSessionId,
      work: this.getBackgroundWork(),
    };
  }

  getControlRuntimeId(): string {
    return this.stopControls.runtimeId;
  }

  resolveStopTarget(target: SessionStopTarget): AcpStopDispatch {
    return this.stopControls.resolve(target);
  }

  private controlFields(kind: SessionStopTarget['kind'], id: string) {
    const stopControl = this.replayingHistory ? undefined : this.stopControls.get(kind, id);
    return stopControl ? { stopControl } : {};
  }

  ownsSession(sessionId: string): boolean {
    return this.children.has(this.childId(sessionId));
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
    if (this.abandonedSessions.has(this.childId(sessionId))) {
      return true;
    }
    // Providers publish the parent spawn before any child output, including on load.
    this.rootSessionId ??= sessionId;
    if (this.consumeLifecycleUpdate(sessionId, update)) {
      return true;
    }
    if (sessionId === this.rootSessionId) {
      if (
        update.sessionUpdate === 'session_info_update' &&
        airMetadata(update)?.loadReplayEnd === true
      ) {
        this.completeHistoryReplay();
        return false;
      }
      this.trackGoal(sessionId, update);
      return false;
    }
    const child = this.children.get(this.childId(sessionId));
    if (child?.activeSessionId === sessionId) {
      this.trackGoal(child.summary.id, update);
      this.append(child, update);
    }
    // Never let a foreign session's updates contaminate the root, even if its spawn was malformed.
    return true;
  }

  private consumeLifecycleUpdate(sessionId: string, update: Record<string, unknown>): boolean {
    const kind = update.sessionUpdate;
    const nativeLifecycle =
      kind === 'subagent_update' ||
      kind === 'subagent_spawned' ||
      kind === 'subagent_state_update' ||
      (typeof kind === 'string' && kind.startsWith('async_task_'));
    if (!nativeLifecycle) {
      return false;
    }
    if (sessionId !== this.rootSessionId && !this.ownsSession(sessionId)) {
      return true;
    }
    // A saved parent ID may still settle existing nested work after a resume,
    // but only its active generation can start or reactivate work.
    if (
      sessionId !== this.rootSessionId &&
      this.children.get(this.childId(sessionId))?.activeSessionId !== sessionId &&
      kind !== 'subagent_state_update' &&
      !(kind === 'async_task_state_update' && update.state !== 'running')
    ) {
      return true;
    }
    switch (kind) {
      case 'subagent_update':
        this.updateChildCapabilities(sessionId, update);
        break;
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
      subagents: children.slice(offset, end).map((child) => ({
        ...child.summary,
        ...this.controlFields('subagent', child.summary.id),
      })),
      nextCursor: end < children.length ? String(end) : null,
    };
  }

  read(input: { subagentId: string; cursor?: string | null; limit: number }): SubagentReadResult {
    const child = this.children.get(this.childId(input.subagentId));
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
      // Stored updates are never mutated, so a fresh array is enough; deep-cloning a
      // multi-megabyte transcript on every read blocked the event loop.
      updates: child.turns
        .slice(start - child.turnOffset, end - child.turnOffset)
        .flatMap((turn) => turn.updates),
      nextCursor: start > child.turnOffset ? String(start) : null,
    };
  }

  private spawn(parentSessionId: string, update: Record<string, unknown>): void {
    const parsed = spawnedSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const { subagentSessionId, name, task, prompt } = parsed.data;
    const id = this.childId(subagentSessionId);
    const nativeGeneration =
      id === subagentSessionId ? 1 : Number(subagentSessionId.split(':').at(-1));
    if (!Number.isSafeInteger(nativeGeneration)) {
      return;
    }
    if (id === this.rootSessionId || id === this.childId(parentSessionId)) {
      return;
    }
    const now = this.observationTimestamp();
    const previous = this.children.get(id);
    if (previous) {
      this.resumeChild(
        previous,
        parentSessionId,
        subagentSessionId,
        nativeGeneration,
        parsed.data.capabilities
      );
      return;
    }
    const child: ChildSession = {
      parentSessionId,
      activeSessionId: subagentSessionId,
      startNewTurn: false,
      generationOffset: 0,
      replayed: false,
      turns: [],
      turnOffset: 0,
      transcriptBytes: 0,
      discardingTurn: false,
      pendingPrompt: false,
      summary: {
        id,
        ...(this.callbacks.groupCodexGenerations ? { generation: nativeGeneration } : {}),
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
    this.setChildControl(child, parsed.data.capabilities);
    this.changed(id, 'created');
    this.publishActivity();
  }

  private resumeChild(
    child: ChildSession,
    parentSessionId: string,
    subagentSessionId: string,
    nativeGeneration: number,
    capabilities: unknown
  ): void {
    // The adapter's live router starts its counter over after loading history.
    if (child.replayed && this.callbacks.groupCodexGenerations) {
      child.generationOffset = (child.summary.generation ?? 1) + 1 - nativeGeneration;
      child.replayed = false;
    }
    const generation = nativeGeneration + child.generationOffset;
    if (generation <= (child.summary.generation ?? 1)) {
      return;
    }
    this.stopControls.invalidateSession(child.activeSessionId);
    child.activeSessionId = subagentSessionId;
    child.parentSessionId = parentSessionId;
    child.startNewTurn = true;
    child.previousUserChunk = undefined;
    child.pendingPrompt = false;
    child.summary.status = 'running';
    child.summary.generation = generation;
    child.summary.completedAt = null;
    child.summary.updatedAt = this.observationTimestamp();
    this.setChildControl(child, capabilities);
    this.changed(child.summary.id, 'updated');
    this.publishActivity();
  }

  private updateChildCapabilities(parentSessionId: string, update: Record<string, unknown>): void {
    const child =
      typeof update.sessionId === 'string'
        ? this.children.get(this.childId(update.sessionId))
        : undefined;
    if (
      child &&
      child.parentSessionId === parentSessionId &&
      child.activeSessionId === update.sessionId &&
      child.summary.status === 'running'
    ) {
      if (Object.hasOwn(update, 'capabilities')) {
        this.setChildControl(child, update.capabilities);
      }
      this.changed(child.summary.id, 'updated');
    }
  }

  private setChildControl(child: ChildSession, capabilities: unknown): void {
    const capability = record(capabilities);
    this.stopControls.set(
      child.summary.id,
      { kind: 'subagent', sessionId: child.activeSessionId },
      !this.replayingHistory && !!record(capability?.cancel)
    );
  }

  private finish(parentSessionId: string, update: Record<string, unknown>): void {
    const parsed = stateSchema.safeParse(update);
    if (!parsed.success) {
      return;
    }
    const child = this.children.get(this.childId(parsed.data.subagentSessionId));
    if (
      !child ||
      child.parentSessionId !== parentSessionId ||
      child.activeSessionId !== parsed.data.subagentSessionId
    ) {
      return;
    }
    child.summary.status = parsed.data.state === 'disconnected' ? 'interrupted' : parsed.data.state;
    child.summary.updatedAt = this.observationTimestamp();
    child.summary.completedAt = child.summary.updatedAt;
    this.stopControls.invalidateSession(child.activeSessionId);
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
    this.workRevision++;
    this.appendTurn(child, value);
    this.updateSummary(child.summary, value);
    this.changed(child.summary.id, 'updated');
    if (
      !this.replayingHistory &&
      (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update')
    ) {
      this.callbacks.onSubagentToolUpdate?.(child.summary.id, value);
    }
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
    if (child.startNewTurn || !(turn || child.discardingTurn) || (user && !sameUserMessage)) {
      turn = { updates: [], bytes: 0 };
      child.turns.push(turn);
      child.discardingTurn = false;
      child.startNewTurn = false;
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
    summary.updatedAt = this.observationTimestamp();
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

  private childId(sessionId: string): string {
    return this.callbacks.groupCodexGenerations ? getSubagentThreadId(sessionId) : sessionId;
  }

  private observationTimestamp(): string | null {
    // Native lifecycle updates omit provider timestamps. Replaying them must not
    // manufacture fresh timeline activity at the time the workspace is opened.
    return this.replayingHistory ? null : new Date().toISOString();
  }

  private isCurrentTaskOwner(sessionId: string): boolean {
    if (sessionId === this.rootSessionId) {
      return true;
    }
    const child = this.children.get(this.childId(sessionId));
    return (
      child?.activeSessionId === sessionId && child.summary.status === 'running' && !child.replayed
    );
  }

  private trackTask(sessionId: string, update: Record<string, unknown>): void {
    const parsed = taskSchema.safeParse(update);
    const rootSessionId = this.rootSessionId;
    if (!(parsed.success && rootSessionId)) {
      return;
    }
    const key = JSON.stringify([sessionId, parsed.data.asyncTaskId]);
    const previous = this.activeTasks.get(key);
    if (update.sessionUpdate === 'async_task_spawned' || parsed.data.state === 'running') {
      this.activeTasks.set(key, {
        name: parsed.data.name?.trim().slice(0, 500) || previous?.name || 'Background task',
        kind: parsed.data.taskType ? taskKind(parsed.data.taskType) : (previous?.kind ?? 'task'),
        active: true,
      });
    } else if (parsed.data.state === 'paused' && previous) {
      this.activeTasks.set(key, { ...previous, active: false });
    } else if (update.sessionUpdate === 'async_task_state_update' && parsed.data.state) {
      this.activeTasks.delete(key);
    }
    const current = this.activeTasks.get(key);
    if (
      update.sessionUpdate === 'async_task_spawned' ||
      parsed.data.canStop !== undefined ||
      !current?.active
    ) {
      this.stopControls.set(
        key,
        { kind: 'task', sessionId: rootSessionId, asyncTaskId: parsed.data.asyncTaskId },
        !this.replayingHistory &&
          this.isCurrentTaskOwner(sessionId) &&
          !!current?.active &&
          parsed.data.canStop === true,
        update.sessionUpdate === 'async_task_spawned',
        sessionId
      );
    }
    this.publishActivity();
  }

  private publishActivity(): void {
    this.workRevision++;
    if (this.replayingHistory) {
      return;
    }
    const work = this.getBackgroundWork();
    const activityKey = JSON.stringify(work);
    // Shells may be permanent preview servers; retain their details without
    // treating them as agent work after the prompt finishes.
    const active =
      work.activeGoals > 0 ||
      work.backgroundTasks.some((task) => task.kind !== 'shell') ||
      work.runningSubagents > 0;
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
