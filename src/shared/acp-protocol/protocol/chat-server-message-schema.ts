import { z } from 'zod';
import { questionValidationSchema } from '@/shared/acp-protocol/question-validation';
import { sessionStopControlSchema } from '@/shared/acp-protocol/subagents';
import { acpPlanNotificationSchema } from '@/shared/acp-protocol/task-plan';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import {
  SESSION_RUNTIME_ACTIVITIES,
  SESSION_RUNTIME_PHASES,
  SESSION_RUNTIME_PROCESS_STATES,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import { AttachmentSchema, ChatSettingsSchema } from '@/shared/websocket/chat-message.schema';
import { ArchivedAgentMessageSchema, ArchivedChatMessageSchema } from './archived-message-schema';
import type { AskUserQuestion } from './interaction';
import type { CommandInfo } from './models';
import { SessionReplayChunkSchema } from './replay-frame-schema';
import {
  AcpPermissionOptionSchema,
  PendingInteractiveRequestWireSchema,
  PendingRequestUpdatedDeltaSchema,
  QueuedMessageWireSchema,
  QueueUpdatedDeltaSchema,
  TranscriptMessageCommittedDeltaSchema,
} from './session-state-delta-schema';
import { MessageState } from './state-machine';
import type { SessionDeltaEvent, WebSocketMessage } from './websocket';

/**
 * Server-to-client frames on the `/chat` WebSocket. The client parses every
 * frame once with `parseChatServerMessage`; the reducer consumes the result
 * as the protocol `WebSocketMessage` type. Object schemas strip undeclared
 * keys.
 */

const SessionRuntimeStateSchema = z.object({
  phase: z.enum(SESSION_RUNTIME_PHASES),
  processState: z.enum(SESSION_RUNTIME_PROCESS_STATES),
  lastExit: z
    .object({ code: z.number().nullable(), timestamp: z.string(), unexpected: z.boolean() })
    .optional(),
  errorMessage: z.string().optional(),
  activity: z.enum(SESSION_RUNTIME_ACTIVITIES),
  work: z
    .object({
      controlRuntimeId: z.string().optional(),
      promptInFlight: z.boolean(),
      backgroundTasks: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['shell', 'turn', 'task']),
          stopControl: sessionStopControlSchema.optional(),
        })
      ),
      runningSubagents: z.number(),
      activeGoals: z.number(),
    })
    .optional(),
  updatedAt: z.string(),
}) satisfies z.ZodType<SessionRuntimeState>;

const SelectableOptionsSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const ChatBarCapabilitiesSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  model: z.object({
    enabled: z.boolean(),
    options: z.array(SelectableOptionsSchema.omit({ description: true })),
    selected: z.string().optional(),
  }),
  reasoning: z.object({
    enabled: z.boolean(),
    options: z.array(SelectableOptionsSchema),
    selected: z.string().optional(),
  }),
  thinking: z.object({ enabled: z.boolean(), defaultBudget: z.number().optional() }),
  planMode: z.object({ enabled: z.boolean() }),
  attachments: z.object({ enabled: z.boolean(), kinds: z.array(z.enum(['image', 'text'])) }),
  slashCommands: z.object({ enabled: z.boolean() }),
  usageStats: z.object({ enabled: z.boolean(), contextWindow: z.boolean() }),
  rewind: z.object({ enabled: z.boolean() }),
}) satisfies z.ZodType<ChatBarCapabilities>;

const AskUserQuestionSchema = z.object({
  id: z.string().optional(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(
    z.object({ label: z.string(), value: z.string().optional(), description: z.string() })
  ),
  multiSelect: z.boolean().optional(),
  optional: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  validation: questionValidationSchema.optional(),
}) satisfies z.ZodType<AskUserQuestion>;

const CommandInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
}) satisfies z.ZodType<CommandInfo>;

const ConfigOptionValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullish(),
});

const ConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  type: z.string(),
  category: z.string().nullish(),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z
    .array(
      z.union([
        ConfigOptionValueSchema,
        z.object({ group: z.string(), options: z.array(ConfigOptionValueSchema) }),
      ])
    )
    .optional(),
});

const UserMessageStateSchema = z.object({
  text: z.string(),
  timestamp: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  settings: ChatSettingsSchema.optional(),
  order: z.number().optional(),
  sessionId: z.string().optional(),
  voiceMode: z.boolean().optional(),
});

const emptyEvent = <Type extends string>(type: Type) => z.object({ type: z.literal(type) });

const LiveLifecycleSchema = z.object({
  eventId: z.string().min(1),
  message: z.string().min(1),
  timestamp: z
    .string()
    .refine((timestamp) => !Number.isNaN(Date.parse(timestamp)), 'Invalid timestamp'),
});

/** Live lifecycle rows render as transcript notices, so they need an id, copy and a time. */
const ChatAgentMessageSchema = ArchivedAgentMessageSchema.superRefine((message, ctx) => {
  if (message.type !== 'session_lifecycle') {
    return;
  }
  for (const issue of LiveLifecycleSchema.safeParse(message.lifecycle).error?.issues ?? []) {
    ctx.addIssue({ ...issue, path: ['lifecycle', ...issue.path] });
  }
});

const ChatTranscriptMessageSchema = ArchivedChatMessageSchema.extend({
  message: ChatAgentMessageSchema.optional(),
});

/** Every event that may travel inside `session_delta` and replay batches. */
export const SessionDeltaEventSchema = z.discriminatedUnion('type', [
  QueueUpdatedDeltaSchema,
  PendingRequestUpdatedDeltaSchema,
  TranscriptMessageCommittedDeltaSchema,
  z.object({
    type: z.literal('subagents_changed'),
    sessionId: z.string().min(1),
    subagentId: z.string().min(1),
    change: z.enum(['created', 'updated', 'completed']),
  }),
  z.object({
    type: z.literal('session_runtime_snapshot'),
    sessionRuntime: SessionRuntimeStateSchema,
  }),
  z.object({
    type: z.literal('session_runtime_updated'),
    sessionRuntime: SessionRuntimeStateSchema,
  }),
  z.object({
    type: z.literal('agent_message'),
    data: ChatAgentMessageSchema,
    messageId: z.string().optional(),
    // The backend assigns every published agent message a transcript order.
    order: z.number(),
  }),
  z.object({
    type: z.literal('assistant_text_delta'),
    messageId: z.string().min(1),
    order: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().min(1),
    code: z.number().optional(),
    requestId: z.string().optional(),
    loadRequestId: z.string().optional(),
  }),
  z.object({
    type: z.literal('permission_request'),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    rawToolName: z.string().optional(),
    toolUseId: z.string().optional(),
    toolInput: z.record(z.string(), z.unknown()).optional(),
    elicitation: z.enum(['form', 'url']).optional(),
    planContent: z.string().nullish(),
    acpOptions: z.array(AcpPermissionOptionSchema).optional(),
  }),
  z.object({
    type: z.literal('user_question'),
    requestId: z.string().min(1),
    toolName: z.string().optional(),
    rawToolName: z.string().optional(),
    questions: z.array(AskUserQuestionSchema),
    acpOptions: z.array(AcpPermissionOptionSchema).optional(),
  }),
  z.object({ type: z.literal('permission_cancelled'), requestId: z.string().min(1) }),
  z.object({
    type: z.literal('message_state_changed'),
    id: z.string().min(1),
    newState: z.enum(MessageState),
    queuePosition: z.number().optional(),
    errorMessage: z.string().optional(),
    userMessage: UserMessageStateSchema.optional(),
  }),
  z.object({
    type: z.literal('tool_progress'),
    tool_use_id: z.string().min(1),
    tool_name: z.string().min(1),
    parent_tool_use_id: z.string().optional(),
    elapsed_time_seconds: z.number(),
    acpStatus: z.string().optional(),
    acpLocations: z.array(z.object({ path: z.string(), line: z.number().nullish() })).optional(),
    acpKind: z.string().optional(),
  }),
  z.object({ type: z.literal('task_notification'), message: z.string().min(1) }),
  emptyEvent('compact_boundary'),
  emptyEvent('compacting_start'),
  emptyEvent('compacting_end'),
  z.object({
    type: z.literal('workspace_notification_request'),
    workspaceId: z.string().optional(),
    workspaceName: z.string().optional(),
    sessionCount: z.number().optional(),
    finishedAt: z.string().optional(),
  }),
  z.object({ type: z.literal('slash_commands'), slashCommands: z.array(CommandInfoSchema) }),
  z.object({ type: z.literal('chat_capabilities'), capabilities: ChatBarCapabilitiesSchema }),
  z.object({
    type: z.literal('config_options_update'),
    configOptions: z.array(ConfigOptionSchema),
  }),
  z.object({ type: z.literal('config_option_applied'), requestId: z.string() }),
]) satisfies z.ZodType<SessionDeltaEvent>;

const SessionSnapshotSchema = z.object({
  type: z.literal('session_snapshot'),
  messages: z.array(ChatTranscriptMessageSchema),
  queuedMessages: z.array(QueuedMessageWireSchema),
  sessionRuntime: SessionRuntimeStateSchema,
  taskPlan: acpPlanNotificationSchema.nullish(),
  pendingInteractiveRequest: PendingInteractiveRequestWireSchema.nullish(),
  loadRequestId: z.string().optional(),
  removedMessageIds: z.array(z.string()).optional(),
  resetTranscript: z.boolean().optional(),
});

const SessionReplayBatchSchema = z.object({
  type: z.literal('session_replay_batch'),
  loadRequestId: z.string().optional(),
  replayEvents: z.array(SessionDeltaEventSchema).optional(),
});

export const ChatServerMessageSchema = z.discriminatedUnion('type', [
  ...SessionDeltaEventSchema.options,
  z.object({ type: z.literal('session_delta'), data: SessionDeltaEventSchema }),
  SessionSnapshotSchema,
  SessionReplayBatchSchema,
  SessionReplayChunkSchema,
]) satisfies z.ZodType<WebSocketMessage>;

/** An element removed from a hydration array because it failed validation. */
export interface DroppedChatElement {
  path: [string, number];
  issues: z.ZodError['issues'];
}

/** Parsed frames are typed by the protocol types, which the schema output satisfies. */
export type ChatServerMessageParseResult =
  | { success: true; message: WebSocketMessage; dropped: DroppedChatElement[] }
  | { success: false; error: z.ZodError };

/**
 * Replay rebuilds a whole session, so one malformed event must not make it
 * unloadable. Drop only those events, reporting each.
 */
function salvageReplayEvents(
  data: unknown
): { data: Record<string, unknown>; dropped: DroppedChatElement[] } | null {
  const batch = z
    .looseObject({ type: z.literal('session_replay_batch'), replayEvents: z.array(z.unknown()) })
    .safeParse(data);
  if (!batch.success) {
    return null;
  }
  const dropped: DroppedChatElement[] = [];
  const replayEvents = batch.data.replayEvents.filter((event, index) => {
    const result = SessionDeltaEventSchema.safeParse(event);
    if (!result.success) {
      dropped.push({ path: ['replayEvents', index], issues: result.error.issues });
    }
    return result.success;
  });
  return dropped.length > 0 ? { data: { ...batch.data, replayEvents }, dropped } : null;
}

/**
 * Parse one server-to-client chat frame. Invalid frames fail as a whole,
 * except that invalid replay events are dropped individually and reported in
 * `dropped`.
 */
export function parseChatServerMessage(data: unknown): ChatServerMessageParseResult {
  const result = ChatServerMessageSchema.safeParse(data);
  if (result.success) {
    return { success: true, message: result.data, dropped: [] };
  }
  const salvaged = salvageReplayEvents(data);
  if (!salvaged) {
    return { success: false, error: result.error };
  }
  const retry = ChatServerMessageSchema.safeParse(salvaged.data);
  return retry.success
    ? { success: true, message: retry.data, dropped: salvaged.dropped }
    : { success: false, error: retry.error };
}
