import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { AcpClientHandler } from '@/backend/services/session/service/acp/acp-client-handler';
import { normalizeSessionUpdateMessage } from '@/backend/services/session/service/acp/acp-stream-normalizer';
import {
  AcpEventProcessor,
  type AcpEventProcessorDependencies,
} from '@/backend/services/session/service/events/acp-event-processor';
import { SessionPermissionService } from '@/backend/services/session/service/events/session.permission.service';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { ChatMessage, HistoryMessage } from '@/shared/acp-protocol';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@/shared/acp-protocol/sdk-types';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { codexSessionHistoryLoaderService } from './codex-session-history-loader.service';
import { loadProviderHistoryTranscript } from './provider-history-transcript-loader';
import { claudeSessionHistoryLoaderService } from './session-history-loader.service';

// Replays the recordings of real Claude and Codex sessions
// (src/backend/testing/fixtures/upstream/<tool>/<runtime version>/) through the
// application's own parsers: the live ACP stream through the stream
// normalizer, client handler, event processor (and its update translator) and
// permission service into a session store, and the history file the CLI wrote
// through the provider history loaders. Tests that use this must mock the ACP
// trace and session file loggers.

export const UPSTREAM_RECORDINGS_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'upstream'
);

const PROVIDERS = { claude: 'CLAUDE', codex: 'CODEX' } as const;

const MetaSchema = z.object({
  tool: z.enum(['claude', 'codex']),
  runtime: z.object({ package: z.string(), version: z.string() }),
  adapter: z.object({ package: z.string(), version: z.string() }),
  scenarios: z.array(z.string()),
});
export type RecordingMeta = z.infer<typeof MetaSchema>;

const JsonRpcMessageSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

export const AcpRecordSchema = z.object({
  dir: z.enum(['client->agent', 'agent->client']),
  message: JsonRpcMessageSchema,
});
export type AcpRecord = z.infer<typeof AcpRecordSchema>;

const PromptParamsSchema = z.looseObject({
  sessionId: z.string(),
  prompt: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});
const SessionUpdateParamsSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});
const PermissionParamsSchema = z.looseObject({
  sessionId: z.string().optional(),
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() })),
});
const PermissionResultSchema = z.object({
  outcome: z.union([
    z.object({ outcome: z.literal('selected'), optionId: z.string() }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
});
const PromptResultSchema = z.looseObject({ stopReason: z.string() });
const NewSessionResultSchema = z.looseObject({ sessionId: z.string() });

export type UpstreamRecording = {
  tool: 'claude' | 'codex';
  provider: 'CLAUDE' | 'CODEX';
  version: string;
  meta: RecordingMeta;
  acp: AcpRecord[];
  /** The history file, one JSON record per line. */
  historyLines: string[];
  /** The ACP session id, which is also the provider's history id. */
  providerSessionId: string;
};

export function readJsonLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function sessionIdOf(acp: AcpRecord[]): string {
  const request = acp.find(
    (record) => record.dir === 'client->agent' && record.message.method === 'session/new'
  );
  const response = acp.find(
    (record) =>
      record.dir === 'agent->client' &&
      record.message.method === undefined &&
      record.message.id === request?.message.id
  );
  return NewSessionResultSchema.parse(response?.message.result).sessionId;
}

/** A recording from its parts, for recordings read from disk or rebuilt in memory. */
export function upstreamRecording(parts: {
  version: string;
  meta: RecordingMeta;
  acp: AcpRecord[];
  historyLines: string[];
}): UpstreamRecording {
  return {
    ...parts,
    tool: parts.meta.tool,
    provider: PROVIDERS[parts.meta.tool],
    providerSessionId: sessionIdOf(parts.acp),
  };
}

/** Every committed recording directory, as `<tool>/<runtime version>`. */
export function listUpstreamRecordingDirectories(): { tool: string; version: string }[] {
  return readdirSync(UPSTREAM_RECORDINGS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((tool) =>
      readdirSync(join(UPSTREAM_RECORDINGS_ROOT, tool.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((version) => ({ tool: tool.name, version: version.name }))
    );
}

export function readUpstreamRecording(tool: string, version: string): UpstreamRecording {
  const directory = join(UPSTREAM_RECORDINGS_ROOT, tool, version);
  return upstreamRecording({
    version,
    meta: MetaSchema.parse(JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))),
    acp: readJsonLines(join(directory, 'acp.jsonl')).map((line) =>
      AcpRecordSchema.parse(JSON.parse(line))
    ),
    historyLines: readJsonLines(join(directory, 'history.jsonl')),
  });
}

export function listUpstreamRecordings(): UpstreamRecording[] {
  return listUpstreamRecordingDirectories().map(({ tool, version }) =>
    readUpstreamRecording(tool, version)
  );
}

/** The agent's answer to a client request, found by id in the other direction. */
function responseTo(acp: AcpRecord[], index: number): AcpRecord | undefined {
  const request = acp[index];
  return acp
    .slice(index + 1)
    .find(
      (record) =>
        record.dir !== request?.dir &&
        record.message.method === undefined &&
        record.message.id === request?.message.id
    );
}

export type LiveReplay = {
  transcript: ChatMessage[];
  /** Each recorded permission request: the answer recorded and the one the application sent. */
  permissions: { recorded: RequestPermissionResponse; sent: RequestPermissionResponse }[];
  /** Each prompt turn's recorded stop reason, in order. */
  stopReasons: string[];
};

const SESSION = 'upstream-recording';
const PROMPT_SETTINGS = {
  selectedModel: null,
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};

/** One recorded session played into the application's live path. */
class LiveSession {
  private readonly domain = new SessionDomainService();
  private readonly permissionService = new SessionPermissionService({
    sessionDomainService: this.domain,
  });
  private readonly processor = new AcpEventProcessor(
    unsafeCoerce<AcpEventProcessorDependencies>({
      sessionDomainService: this.domain,
      runtimeManager: {
        isSessionWorking: () => false,
        isSessionPromptInFlight: () => true,
        getClient: () => null,
      },
      sessionPermissionService: this.permissionService,
      sessionConfigService: {},
      onToolCallTimeout: () => undefined,
    })
  );
  private readonly client: AcpClientHandler;
  private readonly replay: LiveReplay = { transcript: [], permissions: [], stopReasons: [] };
  private prompts = 0;

  constructor(private readonly acp: AcpRecord[]) {
    const handlers = this.processor.createRuntimeEventHandler(SESSION);
    if (!handlers.onAcpEvent) {
      throw new Error('The event processor has no ACP event handler');
    }
    this.client = new AcpClientHandler(SESSION, handlers.onAcpEvent, handlers.permissionBridge);
  }

  async play(): Promise<LiveReplay> {
    for (const [index, record] of this.acp.entries()) {
      const message = JsonRpcMessageSchema.parse(normalizeSessionUpdateMessage(record.message));
      if (record.dir === 'client->agent') {
        this.fromClient(message);
      } else if (message.method === 'session/update') {
        await this.client.sessionUpdate(
          unsafeCoerce<SessionNotification>(SessionUpdateParamsSchema.parse(message.params))
        );
      } else if (message.method === 'session/request_permission') {
        await this.permission(message, index);
      } else if (message.method === undefined) {
        this.response(message, index);
      }
    }
    this.processor.clearSessionState(SESSION);
    return { ...this.replay, transcript: this.domain.getTranscriptSnapshot(SESSION) };
  }

  /** A prompt is committed the way dispatch commits it, then its turn begins. */
  private fromClient(message: JsonRpcMessage): void {
    if (message.method !== 'session/prompt') {
      return;
    }
    const params = PromptParamsSchema.parse(message.params);
    this.prompts += 1;
    this.domain.commitSentUserMessage(SESSION, {
      id: `prompt-${this.prompts}`,
      text: params.prompt.map((block) => block.text ?? '').join(''),
      timestamp: new Date(0).toISOString(),
      settings: PROMPT_SETTINGS,
    });
    this.processor.beginPromptTurn(SESSION);
  }

  /** The request is shown through the permission service and answered as recorded. */
  private async permission(message: JsonRpcMessage, index: number): Promise<void> {
    const recorded = PermissionResultSchema.parse(responseTo(this.acp, index)?.message.result);
    const sent = this.client.requestPermission(
      unsafeCoerce<RequestPermissionRequest>(PermissionParamsSchema.parse(message.params))
    );
    const shown = this.domain.getPendingInteractiveRequest(SESSION);
    if (!shown) {
      throw new Error(`The permission request on line ${index + 1} was not shown`);
    }
    if (recorded.outcome.outcome === 'selected') {
      await this.permissionService.respondToPermission(
        SESSION,
        shown.requestId,
        recorded.outcome.optionId
      );
    } else {
      this.permissionService.cancelPendingRequests(SESSION);
    }
    this.replay.permissions.push({ recorded, sent: await sent });
  }

  /** A prompt's response ends its turn, as a completed prompt does. */
  private response(message: JsonRpcMessage, index: number): void {
    const request = this.acp
      .slice(0, index)
      .findLast(({ dir, message: sent }) => dir === 'client->agent' && sent.id === message.id);
    if (request?.message.method !== 'session/prompt') {
      return;
    }
    const { stopReason } = PromptResultSchema.parse(message.result);
    this.replay.stopReasons.push(stopReason);
    this.processor.finishPromptTurn(SESSION, stopReason);
    this.processor.finalizeOrphanedToolCalls(SESSION, 'prompt_completed');
  }
}

/**
 * The transcript a viewer sees at the end of the recorded session. Each prompt
 * is committed the way dispatch commits it; each agent message passes the
 * stream normalizer, the ACP client handler, the event processor (and its
 * update translator) and the permission service; each permission request is
 * answered through the permission service with the recorded option; each turn
 * ends with the recorded stop reason.
 */
export function replayLiveStream(recording: UpstreamRecording): Promise<LiveReplay> {
  return new LiveSession(recording.acp).play();
}

let historyReads = 0;

/**
 * Runs `read` with the recorded history file where the CLI writes it, in a
 * temporary Claude config directory or Codex home. Environment stubbed with
 * `vi.stubEnv` before the call is unstubbed after it.
 */
async function withRecordedHistoryFile<T>(
  recording: UpstreamRecording,
  read: (workingDir: string) => Promise<T>
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ff-upstream-history-'));
  // Both Codex variables are stubbed: the loader prefers CODEX_SESSIONS_DIR over CODEX_HOME.
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  vi.stubEnv('CODEX_HOME', join(home, 'codex'));
  vi.stubEnv('CODEX_SESSIONS_DIR', join(home, 'codex', 'sessions'));
  configService.reload();
  try {
    const content = `${recording.historyLines.join('\n')}\n`;
    const workingDir = '/workspace';
    if (recording.tool === 'claude') {
      const project = join(home, 'claude', 'projects', workingDir.replace(/\//g, '-'));
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, `${recording.providerSessionId}.jsonl`), content);
    } else {
      const day = join(home, 'codex', 'sessions', '2026', '01', '01');
      mkdirSync(day, { recursive: true });
      writeFileSync(
        join(day, `rollout-2026-01-01T00-00-00-${recording.providerSessionId}.jsonl`),
        content
      );
    }
    return await read(workingDir);
  } finally {
    vi.unstubAllEnvs();
    configService.reload();
    rmSync(home, { recursive: true, force: true });
  }
}

/** The history messages the provider's loader reads from the recorded history file. */
export function loadRecordedHistory(recording: UpstreamRecording): Promise<HistoryMessage[]> {
  return withRecordedHistoryFile(recording, async (workingDir) => {
    const input = { providerSessionId: recording.providerSessionId, workingDir };
    const result =
      recording.tool === 'claude'
        ? await claudeSessionHistoryLoaderService.loadSessionHistory(input)
        : await codexSessionHistoryLoaderService.loadSessionHistory(input);
    if (result.status !== 'loaded') {
      throw new Error(`History did not load: ${result.status}`);
    }
    return result.history;
  });
}

/**
 * The transcript a viewer sees after a restart: the recorded history file read
 * and projected by the shared provider history loader.
 */
export function reloadFromHistory(recording: UpstreamRecording): Promise<ChatMessage[]> {
  return withRecordedHistoryFile(recording, async (workingDir) => {
    historyReads += 1;
    const result = await loadProviderHistoryTranscript(
      `${SESSION}-${historyReads}`,
      {
        provider: recording.provider,
        providerSessionId: recording.providerSessionId,
        providerMetadata: null,
        workspace: { worktreePath: workingDir },
      },
      recording.providerSessionId,
      () => true
    );
    if (result.status !== 'loaded') {
      throw new Error(`History did not load: ${result.status}`);
    }
    return [...result.transcript];
  });
}

/**
 * A transcript row reduced to what a viewer reads: what kind of row it is and
 * its content. Row ids, orders and timestamps differ by construction between
 * the live and reloaded paths and are left out.
 */
export type ComparableRow =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
  | { kind: 'usage'; used: unknown; size: unknown }
  | { kind: 'notice'; severity: string; title: string }
  | { kind: 'other'; message: unknown };

const TextBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
const ToolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
const UsageResultSchema = z.looseObject({
  sessionUpdate: z.literal('usage_update'),
  used: z.unknown(),
  size: z.unknown(),
});

function blockRow(block: unknown): ComparableRow {
  const text = TextBlockSchema.safeParse(block);
  if (text.success) {
    return { kind: 'text', text: text.data.text };
  }
  const result = ToolResultBlockSchema.safeParse(block);
  if (result.success) {
    return {
      kind: 'tool_result',
      toolUseId: result.data.tool_use_id,
      content: result.data.content,
      ...(result.data.is_error === undefined ? {} : { isError: result.data.is_error }),
    };
  }
  return { kind: 'other', message: block };
}

function agentRows(message: NonNullable<ChatMessage['message']>): ComparableRow[] {
  if (message.type === 'assistant' || message.type === 'user') {
    const content = message.message?.content;
    return typeof content === 'string'
      ? [{ kind: 'text', text: content }]
      : (content ?? []).map(blockRow);
  }
  if (message.type === 'stream_event' && message.event?.type === 'content_block_start') {
    const block = message.event.content_block;
    if (block.type === 'tool_use') {
      return [{ kind: 'tool_use', id: block.id, name: block.name, input: block.input }];
    }
    if (block.type === 'thinking') {
      return [{ kind: 'thinking', text: block.thinking }];
    }
  }
  if (message.type === 'result') {
    const usage = UsageResultSchema.safeParse(message.result);
    if (usage.success) {
      return [{ kind: 'usage', used: usage.data.used, size: usage.data.size }];
    }
  }
  if (message.type === 'session_notice') {
    return [{ kind: 'notice', severity: message.notice.severity, title: message.notice.title }];
  }
  return [{ kind: 'other', message }];
}

export function comparableTranscript(transcript: readonly ChatMessage[]): ComparableRow[] {
  return transcript.flatMap((row): ComparableRow[] => {
    if (row.source === 'user') {
      return [{ kind: 'prompt', text: row.text ?? '' }];
    }
    return row.message ? agentRows(row.message) : [{ kind: 'other', message: row }];
  });
}
