import { RequestError } from '@agentclientprotocol/sdk';
import {
  SUBAGENTS_CHANGED_METHOD,
  type SubagentListParams,
  type SubagentListResult,
  type SubagentReadParams,
  type SubagentReadResult,
  type SubagentStatus,
  type SubagentsChangedParams,
  type SubagentTranscriptUpdate,
  subagentsChangedParamsSchema,
} from '@/shared/acp-protocol/subagents';
import type { AdapterSession } from './adapter-state';
import {
  isKnownCodexTurnStatus,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadReadTurn,
  threadListResponseSchema,
  threadReadResponseSchema,
} from './codex-zod';

const TERMINAL_SUMMARY_CONCURRENCY = 4;
const RESULT_PREVIEW_MAX_LENGTH = 240;
const OWNERSHIP_PAGE_LIMIT = 100;
const LIVE_INVALIDATION_THROTTLE_MS = 250;

type ThreadListItem = ThreadListResponse['data'][number];

type CodexSubagentControllerDeps = {
  codex: {
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  requireSession: (sessionId: string) => AdapterSession;
  createProjectionSession: (parent: AdapterSession, threadId: string) => AdapterSession;
  projectThreadTurns: (
    session: AdapterSession,
    turns: ThreadReadTurn[]
  ) => Promise<SubagentTranscriptUpdate[]>;
  extNotification: (method: string, params: Record<string, unknown>) => Promise<void>;
  reportShapeDrift?: (event: string, details?: unknown) => void;
};

export class CodexSubagentController {
  private readonly parentSessionIdBySubagentId = new Map<string, string>();
  private readonly lastLiveInvalidationAtBySubagentId = new Map<string, number>();

  constructor(private readonly deps: CodexSubagentControllerDeps) {}

  async list(params: SubagentListParams): Promise<SubagentListResult> {
    const parent = this.deps.requireSession(params.sessionId);
    const response = await this.listPage(parent, params.cursor ?? null, params.limit);
    const directChildren = response.data.filter(
      (thread) => thread.parentThreadId === parent.threadId
    );
    this.rememberSubagents(
      parent.sessionId,
      directChildren.map((thread) => thread.id)
    );

    const subagents = await mapWithConcurrency(
      directChildren,
      TERMINAL_SUMMARY_CONCURRENCY,
      async (thread) => this.toSummary(thread)
    );

    return {
      subagents,
      nextCursor: response.nextCursor ?? null,
    };
  }

  async read(params: SubagentReadParams): Promise<SubagentReadResult> {
    const parent = this.deps.requireSession(params.sessionId);
    const ownedChild = await this.findOwnedChild(parent, params.subagentId);
    if (!ownedChild) {
      throw RequestError.resourceNotFound();
    }

    this.rememberSubagents(parent.sessionId, [params.subagentId]);
    const thread = await this.readThread(params.subagentId);
    const completeTurns = thread.turns.filter((turn) => turn.status !== 'inProgress');
    const endExclusive = this.resolveReadEnd(completeTurns, params.cursor ?? null, params);
    const start = Math.max(0, endExclusive - params.limit);
    const selectedCompleteTurns = completeTurns.slice(start, endExclusive);
    const currentTurn = params.cursor
      ? undefined
      : [...thread.turns].reverse().find((turn) => turn.status === 'inProgress');
    const selectedTurnIds = new Set(selectedCompleteTurns.map((turn) => turn.id));
    if (currentTurn) {
      selectedTurnIds.add(currentTurn.id);
    }
    const selectedTurns = thread.turns.filter((turn) => selectedTurnIds.has(turn.id));
    const projectionSession = this.deps.createProjectionSession(parent, params.subagentId);
    const updates = await this.deps.projectThreadTurns(projectionSession, selectedTurns);

    return {
      updates,
      nextCursor:
        start > 0 && selectedCompleteTurns[0]
          ? encodeTurnCursor(selectedCompleteTurns[0].id)
          : null,
    };
  }

  rememberSubagents(parentSessionId: string, subagentIds: readonly string[]): void {
    for (const subagentId of subagentIds) {
      this.parentSessionIdBySubagentId.set(subagentId, parentSessionId);
    }
  }

  async recordActivity(
    parentSessionId: string,
    subagentIds: readonly string[],
    change: SubagentsChangedParams['change']
  ): Promise<void> {
    this.rememberSubagents(parentSessionId, subagentIds);
    await Promise.all(
      subagentIds.map((subagentId) => this.notifyChanged(parentSessionId, subagentId, change))
    );
  }

  async handleThreadStatusChanged(subagentId: string, runtimeType: string): Promise<void> {
    const parentSessionId = this.parentSessionIdBySubagentId.get(subagentId);
    if (!parentSessionId) {
      return;
    }
    await this.notifyChanged(
      parentSessionId,
      subagentId,
      runtimeType === 'active' ? 'updated' : 'completed'
    );
  }

  async handleTranscriptActivity(subagentId: string): Promise<void> {
    const parentSessionId = this.parentSessionIdBySubagentId.get(subagentId);
    if (!parentSessionId) {
      return;
    }
    const now = Date.now();
    const lastInvalidationAt = this.lastLiveInvalidationAtBySubagentId.get(subagentId);
    if (
      lastInvalidationAt !== undefined &&
      now - lastInvalidationAt < LIVE_INVALIDATION_THROTTLE_MS
    ) {
      return;
    }
    this.lastLiveInvalidationAtBySubagentId.set(subagentId, now);
    await this.notifyChanged(parentSessionId, subagentId, 'updated');
  }

  async notifyChanged(
    parentSessionId: string,
    subagentId: string,
    change: SubagentsChangedParams['change']
  ): Promise<void> {
    const params = subagentsChangedParamsSchema.parse({
      sessionId: parentSessionId,
      subagentId,
      change,
    });
    try {
      await this.deps.extNotification(SUBAGENTS_CHANGED_METHOD, params);
    } catch {
      // Invalidation is advisory. A closed ACP client must not fail the parent turn.
    }
  }

  private async listPage(
    parent: AdapterSession,
    cursor: string | null,
    limit: number
  ): Promise<ThreadListResponse> {
    const raw = await this.deps.codex.request('thread/list', {
      parentThreadId: parent.threadId,
      cursor,
      limit,
      sortKey: 'created_at',
      sortDirection: 'desc',
    });
    const parsed = threadListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.reportShapeDrift?.('malformed_subagent_thread_list', {
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      throw RequestError.internalError(
        { reason: 'subagent_protocol_error' },
        'Malformed sub-agent list response'
      );
    }
    return parsed.data;
  }

  private async findOwnedChild(
    parent: AdapterSession,
    subagentId: string
  ): Promise<ThreadListItem | null> {
    let cursor: string | null = null;
    const visitedCursors = new Set<string>();
    do {
      const response = await this.listPage(parent, cursor, OWNERSHIP_PAGE_LIMIT);
      const directChildren = response.data.filter(
        (thread) => thread.parentThreadId === parent.threadId
      );
      this.rememberSubagents(
        parent.sessionId,
        directChildren.map((thread) => thread.id)
      );
      const match = directChildren.find((thread) => thread.id === subagentId);
      if (match) {
        return match;
      }
      const nextCursor = response.nextCursor ?? null;
      if (nextCursor && visitedCursors.has(nextCursor)) {
        this.deps.reportShapeDrift?.('repeated_subagent_ownership_cursor');
        throw RequestError.internalError(
          { reason: 'subagent_protocol_error' },
          'Sub-agent ownership pagination repeated a cursor'
        );
      }
      if (nextCursor) {
        visitedCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor);
    return null;
  }

  private async toSummary(
    thread: ThreadListItem
  ): Promise<SubagentListResult['subagents'][number]> {
    const runtimeType = thread.status?.type;
    let lastTurn = thread.turns?.at(-1);
    if (runtimeType !== 'active' && !lastTurn) {
      try {
        lastTurn = (await this.readThread(thread.id)).turns.at(-1);
      } catch {
        lastTurn = undefined;
      }
    }
    if (lastTurn?.status && !isKnownCodexTurnStatus(lastTurn.status)) {
      this.deps.reportShapeDrift?.('unknown_subagent_turn_status', {
        status: lastTurn.status,
      });
    }

    return {
      id: thread.id,
      name: normalizeOptionalText(thread.name) ?? normalizeOptionalText(thread.agentNickname),
      status: normalizeCodexSubagentStatus({
        runtimeType,
        activeFlags: normalizeStringArray(thread.status?.activeFlags),
        lastTurnStatus: lastTurn?.status,
      }),
      createdAt: toIsoTimestamp(thread.createdAt),
      updatedAt: toIsoTimestamp(thread.updatedAt),
      completedAt: runtimeType === 'active' ? null : toIsoTimestamp(lastTurn?.completedAt),
      latestActivity: normalizeOptionalText(thread.preview),
      resultPreview: lastAgentMessagePreview(lastTurn),
    };
  }

  private resolveReadEnd(
    turns: ThreadReadTurn[],
    cursor: string | null,
    params: SubagentReadParams
  ): number {
    if (!cursor) {
      return turns.length;
    }
    const turnId = decodeTurnCursor(cursor);
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) {
      throw RequestError.invalidParams({
        sessionId: params.sessionId,
        subagentId: params.subagentId,
        cursor,
      });
    }
    return index;
  }

  private async readThread(threadId: string): Promise<ThreadReadResponse['thread']> {
    const raw = await this.deps.codex.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    const parsed = threadReadResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.reportShapeDrift?.('malformed_subagent_thread_read', {
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      throw RequestError.internalError(
        { reason: 'subagent_protocol_error' },
        'Malformed sub-agent transcript response'
      );
    }
    const thread = parsed.data.thread;
    if (thread.id !== threadId) {
      this.deps.reportShapeDrift?.('mismatched_subagent_thread_read');
      throw RequestError.internalError(
        { reason: 'subagent_protocol_error' },
        'Sub-agent transcript identity mismatch'
      );
    }
    return thread;
  }
}

export function normalizeCodexSubagentStatus(input: {
  runtimeType?: string;
  activeFlags?: readonly string[];
  lastTurnStatus?: string;
}): SubagentStatus {
  if (input.runtimeType === 'active') {
    if (
      input.activeFlags?.includes('waitingOnApproval') ||
      input.activeFlags?.includes('waitingOnUserInput')
    ) {
      return 'waiting';
    }
    return 'running';
  }
  if (input.runtimeType === 'systemError' || input.lastTurnStatus === 'failed') {
    return 'failed';
  }
  if (input.lastTurnStatus === 'interrupted') {
    return 'interrupted';
  }
  return 'completed';
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function lastAgentMessagePreview(turn: ThreadReadTurn | undefined): string | null {
  if (!turn) {
    return null;
  }
  const agentMessage = [...turn.items]
    .reverse()
    .find((item) => item.type === 'agentMessage' && typeof item.text === 'string');
  if (!agentMessage || typeof agentMessage.text !== 'string') {
    return null;
  }
  const text = agentMessage.text.trim();
  return text.length > 0 ? text.slice(0, RESULT_PREVIEW_MAX_LENGTH) : null;
}

function encodeTurnCursor(turnId: string): string {
  return Buffer.from(JSON.stringify({ turnId }), 'utf8').toString('base64url');
}

function decodeTurnCursor(cursor: string): string {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      !Array.isArray(decoded) &&
      typeof (decoded as { turnId?: unknown }).turnId === 'string' &&
      (decoded as { turnId: string }).turnId.length > 0
    ) {
      return (decoded as { turnId: string }).turnId;
    }
  } catch {
    // Fall through to the standard invalid-params error.
  }
  throw RequestError.invalidParams({ cursor });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await project(value);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
