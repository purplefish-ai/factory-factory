import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionUpdate } from '@/shared/acp-protocol/sdk-types';
import { AcpEventTranslator } from '@/shared/acp-protocol/session-update-translator';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  type ComparableRow,
  comparableTranscript,
  listUpstreamRecordings,
  loadRecordedHistory,
  reloadFromHistory,
  replayLiveStream,
  type UpstreamRecording,
} from './upstream-recordings.test-harness';

// The recordings of real Claude and Codex sessions, read by the application's
// own parsers. Recording them is `node scripts/record-upstream.mjs`; the
// recordings are scrubbed, so nothing here relies on a value the scrubber
// replaced ("<string>", 0, fixed fake ids) being real.

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

const recordings = listUpstreamRecordings();
const name = (recording: UpstreamRecording) => `${recording.tool} ${recording.version}`;

type Rewrite = (row: ComparableRow) => ComparableRow | null | undefined;

/**
 * A way the transcript built from the live stream and the one reloaded from
 * the history file are allowed to differ. Each side's rewrite returns the row
 * in a form both sides share, `null` to drop it, or `undefined` when it does
 * not apply. Every entry must still apply to its recordings, so a fixed
 * difference fails here until it is removed.
 */
type KnownDifference = {
  provider: 'CLAUDE' | 'CODEX';
  /** Only these recording versions; all of the provider's when absent. */
  versions?: string[];
  difference: string;
  reason: string;
  /** Set when the difference looks like a parser defect rather than a property of the tool. */
  defect?: string;
  live?: Rewrite;
  reloaded?: Rewrite;
};

const usageRowsAreLiveOnly = (provider: 'CLAUDE' | 'CODEX'): KnownDifference => ({
  provider,
  difference: 'usage rows',
  reason:
    'Each usage_update is kept as a live row for context occupancy; history has no usage record, and after a restart occupancy comes from the next update.',
  live: (row) => (row.kind === 'usage' ? null : undefined),
});

// The call id and the tool name differ by construction between Codex's two
// records of one command (exec item id and title live, model call id and
// `exec` in the rollout); the command and its output are compared.
const CODE_MODE_CALL = '<exec call>';
const EXEC_COMMAND = /tools\.exec_command\(\{cmd:"((?:[^"\\]|\\.)*)"/;
const ExecOutputSchema = z.array(z.object({ type: z.string(), text: z.string() }));
const ExecChunkSchema = z.looseObject({ output: z.string() });

function codeModeOutput(content: unknown): string | undefined {
  const items = typeof content === 'string' ? ExecOutputSchema.safeParse(safeJson(content)) : null;
  for (const item of items?.success ? items.data : []) {
    const chunk = ExecChunkSchema.safeParse(safeJson(item.text));
    if (chunk.success) {
      return chunk.data.output;
    }
  }
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const KNOWN_DIFFERENCES: KnownDifference[] = [
  usageRowsAreLiveOnly('CLAUDE'),
  {
    provider: 'CLAUDE',
    difference: 'is_error on a successful tool result',
    reason:
      'History records is_error: false on a successful result; the ACP tool_call_update has only status completed, and the translator sets is_error only on failure.',
    reloaded: (row) => {
      if (row.kind !== 'tool_result' || row.isError !== false) {
        return undefined;
      }
      const { isError: _isError, ...rest } = row;
      return rest;
    },
  },
  {
    provider: 'CLAUDE',
    difference: 'empty thinking row',
    reason:
      'The CLI writes the interrupted turn’s thinking block with empty text and only a signature; the adapter sends no thought chunk for it.',
    defect:
      'The Claude loader projects the empty thinking block into a thinking row the live view never had.',
    reloaded: (row) => (row.kind === 'thinking' && row.text === '' ? null : undefined),
  },
  {
    provider: 'CLAUDE',
    difference: 'interrupt notice',
    reason:
      'A cancelled turn leaves "[Request interrupted by user]" in history, shown as a notice after reload; live, the turn only ends with stopReason cancelled, and the stop that caused it records its own row outside the ACP stream.',
    reloaded: (row) =>
      row.kind === 'notice' && row.title === 'Request interrupted' ? null : undefined,
  },
  usageRowsAreLiveOnly('CODEX'),
  {
    provider: 'CODEX',
    versions: ['0.166.0'],
    difference: 'prompts missing after reload',
    reason:
      'Recording artefact: content_item_kinds was scrubbed to "<string>", and the loader keeps a user input_text only when its kind is user.text. policies.mjs keeps the kinds from the next recording.',
    live: (row) => (row.kind === 'prompt' ? null : undefined),
  },
  {
    provider: 'CODEX',
    difference: 'code-mode exec call',
    reason:
      'Codex runs the command through its code-mode exec tool: live, ACP names the exec item and its command; the rollout keeps the model’s call id and the JavaScript it wrote.',
    defect:
      'The Codex loader reloads the call as tool "exec" with the JavaScript as rawArguments, so the command is not shown as one.',
    live: (row) => {
      const input = z
        .looseObject({ command: z.string() })
        .safeParse(row.kind === 'tool_use' && row.input);
      return input.success
        ? {
            kind: 'tool_use',
            id: CODE_MODE_CALL,
            name: CODE_MODE_CALL,
            input: { command: input.data.command },
          }
        : undefined;
    },
    reloaded: (row) => {
      const input = z
        .looseObject({ rawArguments: z.string() })
        .safeParse(row.kind === 'tool_use' && row.name === 'exec' && row.input);
      const command = input.success ? EXEC_COMMAND.exec(input.data.rawArguments)?.[1] : undefined;
      return command === undefined
        ? undefined
        : {
            kind: 'tool_use',
            id: CODE_MODE_CALL,
            name: CODE_MODE_CALL,
            input: { command: z.string().parse(JSON.parse(`"${command}"`)) },
          };
    },
  },
  {
    provider: 'CODEX',
    difference: 'code-mode exec output',
    reason:
      'Live, the result is the terminal output; the rollout keeps the exec tool’s output items, a status line and a JSON chunk holding the output.',
    defect:
      'The Codex loader serialises the output items to a JSON string, so the reloaded result shows that JSON instead of the output.',
    live: (row) =>
      row.kind === 'tool_result'
        ? { kind: 'tool_result', toolUseId: CODE_MODE_CALL, content: row.content }
        : undefined,
    reloaded: (row) => {
      const output = row.kind === 'tool_result' ? codeModeOutput(row.content) : undefined;
      return output === undefined
        ? undefined
        : { kind: 'tool_result', toolUseId: CODE_MODE_CALL, content: output };
    },
  },
];

/** History loader warnings a recording causes, in order, each with its reason. */
const KNOWN_HISTORY_WARNINGS: {
  provider: 'CLAUDE' | 'CODEX';
  message: string;
  reason: string;
}[] = [
  {
    provider: 'CODEX',
    message: 'Codex function call arguments are not valid JSON',
    reason: 'The code-mode exec call’s input is JavaScript (see "code-mode exec call").',
  },
];

function applyDifferences(
  rows: ComparableRow[],
  side: 'live' | 'reloaded',
  differences: KnownDifference[],
  applied: Set<KnownDifference>
): ComparableRow[] {
  return rows.flatMap((original) => {
    let row: ComparableRow | null = original;
    for (const difference of differences) {
      const rewritten: ComparableRow | null | undefined = row ? difference[side]?.(row) : undefined;
      if (rewritten !== undefined) {
        applied.add(difference);
        row = rewritten;
      }
    }
    return row ? [row] : [];
  });
}

/** Spies on every application logger's warnings. */
function spyOnWarnings(): MockInstance {
  return vi.spyOn(Object.getPrototypeOf(createLogger('upstream-recordings')), 'warn');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upstream recordings', () => {
  it('cover both providers', () => {
    expect(new Set(recordings.map(({ provider }) => provider))).toEqual(
      new Set(['CLAUDE', 'CODEX'])
    );
  });

  describe.each(recordings.map((recording) => [name(recording), recording] as const))(
    '%s',
    (_name, recording) => {
      let warnings: MockInstance;
      beforeEach(() => {
        warnings = spyOnWarnings();
      });

      it('translates every recorded session update without a warning', () => {
        const logged: string[] = [];
        const translator = new AcpEventTranslator({ warn: (message) => logged.push(message) });
        const updates = recording.acp.flatMap(({ dir, message }) =>
          dir === 'agent->client' && message.method === 'session/update'
            ? [
                z
                  .object({ update: z.looseObject({ sessionUpdate: z.string() }) })
                  .parse(message.params).update,
              ]
            : []
        );
        const deltas = updates.flatMap((update) =>
          translator.translateSessionUpdate(unsafeCoerce<SessionUpdate>(update), 'recording')
        );
        expect(updates.length).toBeGreaterThan(0);
        expect(deltas.length).toBeGreaterThan(0);
        expect(logged).toEqual([]);
      });

      it('reads every recorded history line, warning only as listed', async () => {
        const history = await loadRecordedHistory(recording);
        expect(history.length).toBeGreaterThan(0);
        expect(warnings.mock.calls.map(([message]) => message)).toEqual(
          KNOWN_HISTORY_WARNINGS.filter(({ provider }) => provider === recording.provider).map(
            ({ message }) => message
          )
        );
      });

      it('replays the live stream without a warning, answering each permission as recorded', async () => {
        const live = await replayLiveStream(recording);
        expect(warnings).not.toHaveBeenCalled();
        expect(live.permissions.length).toBeGreaterThan(0);
        for (const { recorded, sent } of live.permissions) {
          expect(sent).toEqual(recorded);
        }
        expect(live.stopReasons.length).toBe(recording.meta.scenarios.length);
      });

      it('builds the same transcript live and reloaded from history, apart from the known differences', async () => {
        const differences = KNOWN_DIFFERENCES.filter(
          (difference) =>
            difference.provider === recording.provider &&
            (difference.versions?.includes(recording.version) ?? true)
        );
        const applied = new Set<KnownDifference>();
        const live = applyDifferences(
          comparableTranscript((await replayLiveStream(recording)).transcript),
          'live',
          differences,
          applied
        );
        const reloaded = applyDifferences(
          comparableTranscript(await reloadFromHistory(recording)),
          'reloaded',
          differences,
          applied
        );
        expect(reloaded).toEqual(live);
        expect(
          differences.filter((difference) => !applied.has(difference)).map((d) => d.difference),
          'listed differences that no longer occur'
        ).toEqual([]);
      });
    }
  );
});

// Parser inputs no recording has an example of. Each keyed list is checked
// against what the parser handles and what the recordings contain, so a new
// recording that covers one fails here until its entry is removed.
const NOT_RECORDED = {
  sessionUpdates: {
    agent_thought_chunk: 'Neither tool streamed reasoning text in the recorded turns.',
    plan: 'No recorded prompt asked for a plan.',
    current_mode_update: 'The recorded sessions changed mode only before the first prompt.',
    user_message_chunk: 'Sent only when a session is loaded or resumed; no recording loads one.',
    compaction_update: 'No recorded session was compacted.',
    compaction_summary_chunk: 'No recorded session was compacted.',
    context_compaction: 'No recorded session was compacted.',
  },
  claudeHistoryBlocks: {
    string: 'Every recorded message has an array of content blocks.',
    image: 'No recorded prompt had an image.',
    server_tool_use: 'No server tool (web search or fetch) ran.',
    mcp_tool_use: 'The recording ran with no MCP servers.',
    tool_search_tool_result: 'No server tool ran.',
    web_fetch_tool_result: 'No server tool ran.',
    web_search_tool_result: 'No server tool ran.',
    code_execution_tool_result: 'No server tool ran.',
    bash_code_execution_tool_result: 'No server tool ran.',
    text_editor_code_execution_tool_result: 'No server tool ran.',
    mcp_tool_result: 'The recording ran with no MCP servers.',
  },
  codexHistoryRecords: {
    'response_item:function_call': 'Codex 0.166 ran its command through the code-mode exec tool.',
    'response_item:function_call_output':
      'Codex 0.166 ran its command through the code-mode exec tool.',
    'event_msg:user_message': 'Codex 0.166 records prompts as item_completed events instead.',
    'event_msg:agent_message': 'Codex 0.166 records replies as item_completed events instead.',
  },
  /** Inputs not keyed above, for a reader choosing the next recording. */
  other: [
    'Subagents: Claude sidechain history, native subagent sessions and their ACP notifications.',
    'A failed tool call (is_error true) and a rejected permission request.',
    'AskUserQuestion and Codex request_user_input questions, and their history answers.',
    'Elicitation requests, extension notifications (task status, subagents changed).',
    'A Codex interrupt, and Claude reasoning text (the CLI wrote an empty thinking block).',
    'session/load and session/resume, with their replayed history.',
    'Claude task notifications, meta and compact-summary history records.',
  ],
};

// What each parser handles: the update translator's cases, the Claude
// loader's content blocks and the Codex loader's records.
const TRANSLATED_UPDATES = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'usage_update',
  'config_option_update',
  'compaction_update',
  'compaction_summary_chunk',
  'context_compaction',
  'session_info_update',
  'current_mode_update',
  'user_message_chunk',
];
const CLAUDE_HISTORY_BLOCKS = [
  'string',
  'text',
  'thinking',
  'image',
  'tool_use',
  'server_tool_use',
  'mcp_tool_use',
  'tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'mcp_tool_result',
];
const CODEX_HISTORY_RECORDS = [
  'response_item:message',
  'response_item:function_call',
  'response_item:custom_tool_call',
  'response_item:function_call_output',
  'response_item:custom_tool_call_output',
  'event_msg:user_message',
  'event_msg:agent_message',
  'event_msg:task_started',
];

const HistoryRecordSchema = z.looseObject({
  type: z.string().optional(),
  message: z.looseObject({ content: z.unknown().optional() }).optional(),
  payload: z.looseObject({ type: z.string().optional() }).optional(),
});

function recordedInputs(tool: 'claude' | 'codex'): Set<string> {
  const lines = recordings
    .filter((recording) => recording.tool === tool)
    .flatMap(({ historyLines }) =>
      historyLines.map((line) => HistoryRecordSchema.parse(JSON.parse(line)))
    );
  if (tool === 'codex') {
    return new Set(lines.map((record) => `${record.type}:${record.payload?.type}`));
  }
  return new Set(
    lines
      .filter((record) => record.type === 'user' || record.type === 'assistant')
      .flatMap((record) => {
        const content = record.message?.content;
        return Array.isArray(content)
          ? content.map((block) => z.looseObject({ type: z.string() }).parse(block).type)
          : [typeof content];
      })
  );
}

function notCovered(handled: string[], recorded: Set<string>): string[] {
  return handled.filter((input) => !recorded.has(input)).sort();
}

describe('what no recording covers', () => {
  it('lists every session update kind the translator handles but no recording has', () => {
    const recorded = new Set(
      recordings.flatMap(({ acp }) =>
        acp.flatMap(({ message }) =>
          message.method === 'session/update'
            ? [
                z
                  .object({ update: z.object({ sessionUpdate: z.string() }).loose() })
                  .parse(message.params).update.sessionUpdate,
              ]
            : []
        )
      )
    );
    expect(notCovered(TRANSLATED_UPDATES, recorded)).toEqual(
      Object.keys(NOT_RECORDED.sessionUpdates).sort()
    );
  });

  it('lists every Claude history content block the loader reads but no recording has', () => {
    expect(notCovered(CLAUDE_HISTORY_BLOCKS, recordedInputs('claude'))).toEqual(
      Object.keys(NOT_RECORDED.claudeHistoryBlocks).sort()
    );
  });

  it('lists every Codex history record the loader reads but no recording has', () => {
    expect(notCovered(CODEX_HISTORY_RECORDS, recordedInputs('codex'))).toEqual(
      Object.keys(NOT_RECORDED.codexHistoryRecords).sort()
    );
  });
});
