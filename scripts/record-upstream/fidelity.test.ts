import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AcpRecordSchema,
  comparableTranscript,
  listUpstreamRecordingDirectories,
  readJsonLines,
  readUpstreamRecording,
  reloadFromHistory,
  replayLiveStream,
  UPSTREAM_RECORDINGS_ROOT,
  type UpstreamRecording,
  upstreamRecording,
} from '@/backend/services/session/service/data/upstream-recordings.test-harness';
import {
  createScrubContext,
  PLACEHOLDER_STRING,
  POLICIES,
  REDACTED,
  scrubArgument,
  scrubRecord,
} from './scrub.mjs';

// The scrubber decides what a recording keeps; the application's parsers read
// what it kept. This test scrubs the committed recordings again, in process,
// with the current policies, and fails when a value a recording kept would be
// lost at the next recording, or when the parsers would read anything
// differently. Byte equality is not the test: fake ids and timestamps are
// handed out again in order, and an id the scrubber now fakes may change.

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

type Policy = (typeof POLICIES)[keyof typeof POLICIES];

// The streams of each tool, in the order scripts/record-upstream.mjs scrubs
// them with one shared context.
const STREAMS: Record<string, [file: string, policy: Policy, history: boolean][]> = {
  claude: [
    ['acp.jsonl', POLICIES.acp, false],
    ['cli-stdio.jsonl', POLICIES.claudeStdio, false],
    ['history.jsonl', POLICIES.claudeHistory, true],
  ],
  codex: [
    ['app-server.jsonl', POLICIES.codexAppServer, false],
    ['acp.jsonl', POLICIES.acp, false],
    ['history.jsonl', POLICIES.codexRollout, true],
  ],
};

// The roots a recording's placeholders stand for, mapped to themselves.
const ROOTS = {
  '/workspace': '/workspace',
  '/recording-tmp': '/recording-tmp',
  '/user-home': '/user-home',
};

type StreamRecord = { kind: string; value: unknown };

/** Each record of a stream with its policy kind, as the scrubber saw it. */
function withKinds(records: unknown[], policy: Policy, history: boolean): StreamRecord[] {
  const requests = new Map<string, string>();
  return records.map((value) => {
    const message = history ? value : (value as { message?: unknown }).message;
    const dir = history ? undefined : (value as { dir?: string }).dir;
    const kind =
      message !== null && typeof message === 'object' && !Array.isArray(message)
        ? policy.kindOf(message, { dir, requests })
        : 'line';
    return { kind: String(kind), value };
  });
}

function readStream(tool: string, version: string, file: string): unknown[] {
  return readJsonLines(join(UPSTREAM_RECORDINGS_ROOT, tool, version, file)).map((line) =>
    JSON.parse(line)
  );
}

/** Scrubs a recording's streams again, the way the recorder scrubs raw captures. */
function rescrub(tool: string, version: string): Record<string, unknown[]> {
  const context = createScrubContext({ roots: ROOTS });
  const streams: Record<string, unknown[]> = {};
  for (const [file, policy, history] of STREAMS[tool] ?? []) {
    streams[file] = readStream(tool, version, file).map((record) => {
      if (history) {
        return scrubRecord(record, policy, context);
      }
      const { dir, message, args } = record as { dir: string; message?: unknown; args?: string[] };
      if (args) {
        return { dir, args: args.map(scrubArgument) };
      }
      return {
        dir,
        message:
          message !== null && typeof message === 'object'
            ? scrubRecord(message, policy, context, dir)
            : message,
      };
    });
  }
  return streams;
}

// The scrubber's fixed fakes: UUIDs, prefixed ids, random ids and timestamps.
const FAKES =
  /00000000-0000-4000-8000-[0-9a-f]{12}|\b[a-z]{2,12}[-_]0*Fake\d+\b|\bfake-\d+\b|2026-01-01T\d{2}:\d{2}:\d{2}\.000Z/g;
const isPlaceholder = (value: string) =>
  value === PLACEHOLDER_STRING || value === REDACTED || /^<key(-\d+)?>$/.test(value);
const withoutFakes = (value: string) => value.replace(FAKES, '<fake>');
const isFake = (value: string) => withoutFakes(value) === '<fake>';

function jsonObject(value: string): object | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const childPath = (path: string, key: string) =>
  path === '' || path.endsWith('>') ? `${path}${key}` : `${path}.${key}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function stringLosses(committed: string, again: string, path: string): string[] {
  if (isPlaceholder(committed) || withoutFakes(committed) === withoutFakes(again)) {
    return [];
  }
  const [left, right] = [jsonObject(committed), jsonObject(again)];
  if (left && right) {
    return losses(left, right, `${path}>`);
  }
  // An id the scrubber now fakes (a random request or chunk id) is not a loss.
  return isFake(again) ? [] : [path];
}

function objectLosses(
  committed: Record<string, unknown>,
  again: Record<string, unknown>,
  path: string
): string[] {
  return Object.entries(committed).flatMap(([key, value]) => {
    if (isPlaceholder(key) || isFake(key)) {
      return [];
    }
    const child = childPath(path, key);
    return key in again ? losses(value, again[key], child) : [child];
  });
}

/**
 * Paths (in the policies' notation: keys joined by `.`, array levels
 * skipped, `>` into JSON held in a string) where the committed value is real
 * and the re-scrubbed one is not, or where the two differ otherwise.
 */
function losses(committed: unknown, again: unknown, path = ''): string[] {
  if (typeof committed === 'string' && typeof again === 'string') {
    return stringLosses(committed, again, path);
  }
  if (Array.isArray(committed) && Array.isArray(again) && committed.length === again.length) {
    return committed.flatMap((item, index) => losses(item, again[index], path));
  }
  if (isRecord(committed) && isRecord(again)) {
    return objectLosses(committed, again, path);
  }
  return committed === again ? [] : [path];
}

type Loss = { file: string; kind: string; path: string };
const describeLoss = ({ file, kind, path }: Loss) => `${file} ${kind} ${path}`;

/**
 * Values a committed recording keeps that the current policies drop, each with
 * its reason. None may be a path a parser reads (PARSER_READS).
 */
const TOLERATED_LOSSES: (Loss & { tool: string; reason: string })[] = [
  {
    tool: 'claude',
    file: 'cli-stdio.jsonl',
    kind: 'control_response:initialize',
    path: 'message.response.response.user_output_styles_dir',
    reason:
      'A directory in the recording account’s home, kept before the path rule tightened; only paths in the repository or the session’s project directory survive, and no parser reads it.',
  },
  {
    tool: 'codex',
    file: 'history.jsonl',
    kind: 'world_state',
    path: 'payload.state.environments.environments.local.status',
    reason:
      'World state is opaque (it carries the session’s instructions) and keeps only its top-level discriminators; no parser reads it.',
  },
];

// What the application's parsers read, by tool, stream and record kind (`*`
// is every kind): the stream normalizer, ACP client handler, event processor,
// update translator and permission service read acp.jsonl; the history
// loaders read history.jsonl.
const ACP_READS = {
  '*': [
    'message.method',
    'message.id',
    ...[
      'sessionUpdate',
      'messageId',
      'content.type',
      'content.text',
      'content.terminalId',
      'toolCallId',
      'title',
      'kind',
      'status',
      'name',
      'rawInput.command',
      'rawInput.description',
      '_meta.claudeCode.toolName',
      '_meta.terminal_output_delta.data',
      'availableCommands.name',
      'configOptions.id',
      'configOptions.currentValue',
    ].map((path) => `message.params.update.${path}`),
    ...['prompt.type', 'prompt.text', 'toolCall.toolCallId', 'toolCall.title'].map(
      (path) => `message.params.${path}`
    ),
    ...['toolCall.rawInput.command', 'options.optionId', 'options.kind', 'options.name'].map(
      (path) => `message.params.${path}`
    ),
    ...['sessionId', 'stopReason', 'outcome.outcome', 'outcome.optionId'].map(
      (path) => `message.result.${path}`
    ),
  ],
};
const CLAUDE_MESSAGE_READS = [
  'type',
  'sessionId',
  'uuid',
  'timestamp',
  'origin.kind',
  'message.role',
  'message.id',
  ...['type', 'text', 'thinking', 'name', 'id', 'input.command', 'input.description'].map(
    (path) => `message.content.${path}`
  ),
  ...['tool_use_id', 'content', 'content.text'].map((path) => `message.content.${path}`),
];
const CODEX_MESSAGE_READS = [
  ...['role', 'phase', 'content.type', 'content.text', 'content.image_url'].map(
    (path) => `payload.${path}`
  ),
  'payload.internal_chat_message_metadata_passthrough.turn_id',
  'payload.internal_chat_message_metadata_passthrough.content_item_kinds',
];
const PARSER_READS: Record<string, Record<string, Record<string, string[]>>> = {
  claude: {
    'acp.jsonl': ACP_READS,
    'history.jsonl': { user: CLAUDE_MESSAGE_READS, assistant: CLAUDE_MESSAGE_READS },
  },
  codex: {
    'acp.jsonl': ACP_READS,
    'history.jsonl': {
      '*': ['type', 'timestamp', 'payload.type', 'payload.turn_id'],
      session_meta: ['payload.id', 'payload.cwd'],
      'response_item:message:user': CODEX_MESSAGE_READS,
      'response_item:message:assistant': CODEX_MESSAGE_READS,
      'response_item:message:developer': ['payload.role', 'payload.content.type'],
      'response_item:custom_tool_call': ['payload.name', 'payload.call_id', 'payload.input'],
      'response_item:custom_tool_call_output': [
        'payload.call_id',
        'payload.output.type',
        'payload.output.text',
      ],
    },
  },
};

/**
 * Values a parser reads that a committed recording had already lost when it
 * was recorded. The policies keep them from the next recording.
 */
const RECORDING_LOSSES: (Loss & { tool: string; version: string; reason: string })[] = [
  {
    tool: 'codex',
    version: '0.166.0',
    file: 'history.jsonl',
    kind: 'response_item:message:user',
    path: 'payload.internal_chat_message_metadata_passthrough.content_item_kinds',
    reason:
      'Recorded before policies.mjs kept content item kinds; the loader drops the prompts without them.',
  },
  {
    tool: 'codex',
    version: '0.166.0',
    file: 'history.jsonl',
    kind: 'response_item:message:assistant',
    path: 'payload.internal_chat_message_metadata_passthrough.content_item_kinds',
    reason: 'Recorded before policies.mjs kept content item kinds.',
  },
];

/** The leaf values at a path, through arrays. */
function valuesAt(value: unknown, path: string): unknown[] {
  const [key, ...rest] = path.split('.');
  if (Array.isArray(value)) {
    return value.flatMap((item) => valuesAt(item, path));
  }
  if (key === undefined || value === null || typeof value !== 'object') {
    return [];
  }
  const child = (value as Record<string, unknown>)[key];
  if (child === undefined) {
    return [];
  }
  return rest.length === 0
    ? Array.isArray(child)
      ? child
      : [child]
    : valuesAt(child, rest.join('.'));
}

function readsFor(tool: string, file: string, kind: string): string[] {
  const reads = PARSER_READS[tool]?.[file] ?? {};
  return [...(reads['*'] ?? []), ...(reads[kind] ?? [])];
}

const recordingDirectories = listUpstreamRecordingDirectories();

/** Fake ids and timestamps renumbered in order of first appearance. */
function canonicalFakes(value: unknown): string {
  const seen = new Map<string, string>();
  return (
    JSON.stringify(value)
      // Codex's random output chunk id, which the 0.166.0 recording kept and the scrubber now fakes.
      .replace(/(\\*"chunk_id\\*":\\*")[^"\\]*/g, '$1<chunk>')
      .replace(FAKES, (match) => {
        if (!seen.has(match)) {
          seen.set(match, `<fake-${seen.size}>`);
        }
        return seen.get(match) ?? match;
      })
  );
}

/** What the parsers make of a recording: both transcripts and the permission answers. */
async function parsed(recording: UpstreamRecording): Promise<string> {
  const live = await replayLiveStream(recording);
  const reloaded = await reloadFromHistory(recording);
  return canonicalFakes({
    live: comparableTranscript(live.transcript),
    permissions: live.permissions,
    reloaded: comparableTranscript(reloaded),
  });
}

/** A copy of a Codex rollout record with each scrubbed content item kind set to `kind`. */
function withContentItemKinds(record: unknown, kind: string): unknown {
  const copy = structuredClone(record);
  for (const metadata of valuesAt(copy, 'payload.internal_chat_message_metadata_passthrough')) {
    const kinds = (metadata as { content_item_kinds?: unknown }).content_item_kinds;
    if (Array.isArray(kinds)) {
      kinds.fill(kind);
    }
  }
  return copy;
}

/** Each record of each stream of a committed recording, with its file and policy kind. */
function committedRecords(
  tool: string,
  version: string
): (StreamRecord & { file: string; index: number })[] {
  return (STREAMS[tool] ?? []).flatMap(([file, policy, history]) =>
    withKinds(readStream(tool, version, file), policy, history).map((record, index) => ({
      ...record,
      file,
      index,
    }))
  );
}

/** Values the committed recording kept that scrubbing it again would lose. */
function rescrubLosses(tool: string, version: string): string[] {
  const again = rescrub(tool, version);
  const found = committedRecords(tool, version).flatMap(({ file, kind, value, index }) =>
    losses(value, again[file]?.[index]).map((path) => describeLoss({ file, kind, path }))
  );
  return [...new Set(found)].sort();
}

/** Paths a parser reads where the committed recording holds a placeholder. */
function placeholdersParsersRead(tool: string, version: string): string[] {
  const found = committedRecords(tool, version).flatMap(({ file, kind, value }) =>
    readsFor(tool, file, kind)
      .filter((path) =>
        valuesAt(value, path).some((item) => typeof item === 'string' && isPlaceholder(item))
      )
      .map((path) => describeLoss({ file, kind, path }))
  );
  return [...new Set(found)].sort();
}

describe('scrubbing a committed recording again', () => {
  it('tolerates no loss at a path a parser reads', () => {
    for (const loss of TOLERATED_LOSSES) {
      expect(readsFor(loss.tool, loss.file, loss.kind), describeLoss(loss)).not.toContain(
        loss.path
      );
    }
  });

  describe.each(
    recordingDirectories.map(({ tool, version }) => [`${tool} ${version}`, tool, version])
  )('%s', (_name, tool, version) => {
    it('loses no value the recording kept, apart from the tolerated losses', () => {
      expect(rescrubLosses(tool, version)).toEqual(
        TOLERATED_LOSSES.filter((loss) => loss.tool === tool)
          .map(describeLoss)
          .sort()
      );
    });

    it('holds every value a parser reads, apart from the listed recording losses', () => {
      expect(placeholdersParsersRead(tool, version)).toEqual(
        RECORDING_LOSSES.filter((loss) => loss.tool === tool && loss.version === version)
          .map(describeLoss)
          .sort()
      );
    });

    it('is read the same way by the parsers', async () => {
      const committed = readUpstreamRecording(tool, version);
      const again = rescrub(tool, version);
      const rescrubbed = upstreamRecording({
        version,
        meta: committed.meta,
        acp: (again['acp.jsonl'] ?? []).map((record) => AcpRecordSchema.parse(record)),
        historyLines: (again['history.jsonl'] ?? []).map((record) => JSON.stringify(record)),
      });
      expect(await parsed(rescrubbed)).toBe(await parsed(committed));
    });
  });

  it('keeps the content item kinds that the Codex 0.166.0 recording lost', () => {
    // An invented kind stands in for the value the recording lost.
    const context = createScrubContext({ roots: ROOTS });
    const kept = readStream('codex', '0.166.0', 'history.jsonl').flatMap((record) =>
      valuesAt(
        scrubRecord(withContentItemKinds(record, 'user.text'), POLICIES.codexRollout, context),
        'payload.internal_chat_message_metadata_passthrough.content_item_kinds'
      )
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(new Set(kept)).toEqual(new Set(['user.text']));
  });
});
