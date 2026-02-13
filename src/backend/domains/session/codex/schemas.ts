import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const CodexRequestIdSchema = z.union([z.number(), z.string()]);
const CodexApprovalDecisionSchema = z.enum(['accept', 'decline']);

export const CodexReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>;

export const CodexReasoningEffortOptionSchema = z.object({
  reasoningEffort: CodexReasoningEffortSchema,
  description: z.string(),
});

const CodexReasoningEffortDocOptionSchema = z.object({
  effort: CodexReasoningEffortSchema,
  description: z.string(),
});

const CodexModelWireSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
    upgrade: z.string().nullable().optional(),
    displayName: z.string().min(1),
    description: z.string().optional(),
    supportedReasoningEfforts: z.array(CodexReasoningEffortOptionSchema).optional(),
    reasoningEffort: z.array(CodexReasoningEffortDocOptionSchema).optional(),
    defaultReasoningEffort: CodexReasoningEffortSchema,
    inputModalities: z.array(z.string()).optional(),
    supportsPersonality: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough();

export const CodexModelSchema = CodexModelWireSchema.transform((model) => ({
  id: model.id,
  model: model.model,
  upgrade: model.upgrade ?? null,
  displayName: model.displayName,
  description: model.description ?? '',
  supportedReasoningEfforts:
    model.supportedReasoningEfforts ??
    model.reasoningEffort?.map((effort) => ({
      reasoningEffort: effort.effort,
      description: effort.description,
    })) ??
    [],
  defaultReasoningEffort: model.defaultReasoningEffort,
  inputModalities: model.inputModalities ?? ['text', 'image'],
  supportsPersonality: model.supportsPersonality,
  isDefault: model.isDefault,
}));

export type CodexModel = z.infer<typeof CodexModelSchema>;

export const CodexModelListResponseSchema = z.object({
  data: z.array(CodexModelSchema),
  nextCursor: z.string().nullable(),
});

export const CodexTransportEnvelopeSchema = z
  .object({
    id: CodexRequestIdSchema.optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export const CodexTransportResponseSchema = z
  .object({
    id: CodexRequestIdSchema,
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough()
  .refine((value) => value.result !== undefined || value.error !== undefined, {
    message: 'Codex response must include result or error',
  });

export const CodexTransportServerRequestSchema = z
  .object({
    id: CodexRequestIdSchema,
    method: NonEmptyStringSchema,
    params: z.unknown().optional(),
  })
  .passthrough();

export const CodexTransportErrorSchema = z
  .object({
    code: z.number(),
    message: NonEmptyStringSchema,
    data: z.unknown().optional(),
  })
  .passthrough();

const CodexCommandExecutionRequestApprovalResponseSchema = z.object({
  decision: CodexApprovalDecisionSchema,
});

const CodexFileChangeRequestApprovalResponseSchema = z.object({
  decision: CodexApprovalDecisionSchema,
});

const CodexToolRequestUserInputAnswerSchema = z.object({
  answers: z.array(z.string()),
});

const CodexToolRequestUserInputResponseSchema = z.object({
  answers: z.record(z.string(), CodexToolRequestUserInputAnswerSchema),
});

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const UnknownArraySchema = z.array(z.unknown());

const InitializeParamsSchema = z
  .object({
    clientInfo: z.object({
      name: NonEmptyStringSchema,
      version: NonEmptyStringSchema,
      title: z.string().nullable().optional(),
    }),
    capabilities: z
      .object({
        experimentalApi: z.boolean(),
        optOutNotificationMethods: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const ThreadStartParamsSchema = z
  .object({
    cwd: z.string().nullable().optional(),
    experimentalRawEvents: z.boolean(),
    model: z.string().nullable().optional(),
  })
  .passthrough();

const ThreadResumeParamsSchema = z
  .object({
    threadId: NonEmptyStringSchema,
  })
  .passthrough();

const ThreadReadParamsSchema = z
  .object({
    threadId: NonEmptyStringSchema,
    includeTurns: z.boolean(),
  })
  .passthrough();

const TurnStartTextInputSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    text_elements: UnknownArraySchema,
  })
  .passthrough();

const TurnStartImageInputSchema = z
  .object({
    type: z.literal('image'),
    url: NonEmptyStringSchema,
  })
  .passthrough();

const TurnStartLocalImageInputSchema = z
  .object({
    type: z.literal('localImage'),
    path: NonEmptyStringSchema,
  })
  .passthrough();

const TurnStartSkillInputSchema = z
  .object({
    type: z.literal('skill'),
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
  })
  .passthrough();

const TurnStartMentionInputSchema = z
  .object({
    type: z.literal('mention'),
    name: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
  })
  .passthrough();

const TurnStartParamsSchema = z
  .object({
    threadId: NonEmptyStringSchema,
    input: z
      .array(
        z.union([
          TurnStartTextInputSchema,
          TurnStartImageInputSchema,
          TurnStartLocalImageInputSchema,
          TurnStartSkillInputSchema,
          TurnStartMentionInputSchema,
        ])
      )
      .min(1),
    model: z.string().nullable().optional(),
    effort: CodexReasoningEffortSchema.nullable().optional(),
  })
  .passthrough();

const TurnInterruptParamsSchema = z
  .object({
    threadId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
  })
  .passthrough();

const ModelListParamsSchema = z
  .object({
    limit: z.number().int().positive().max(1000).nullable().optional(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

const CodexRequestParamSchemas = {
  initialize: InitializeParamsSchema,
  'thread/start': ThreadStartParamsSchema,
  'thread/resume': ThreadResumeParamsSchema,
  'thread/read': ThreadReadParamsSchema,
  'turn/start': TurnStartParamsSchema,
  'turn/interrupt': TurnInterruptParamsSchema,
  'model/list': ModelListParamsSchema,
} as const;

const NotificationTextDirectSchema = z
  .object({
    text: NonEmptyStringSchema.optional(),
    delta: NonEmptyStringSchema.optional(),
    chunk: NonEmptyStringSchema.optional(),
  })
  .passthrough();

const NotificationTextNestedSchema = z
  .object({
    item: z
      .object({
        text: NonEmptyStringSchema.optional(),
        delta: NonEmptyStringSchema.optional(),
        content: NonEmptyStringSchema.optional(),
        message: z
          .object({
            content: z
              .array(
                z
                  .object({
                    text: NonEmptyStringSchema.optional(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ToolCallNotificationSchema = z
  .object({
    toolUseId: NonEmptyStringSchema.optional(),
    toolName: NonEmptyStringSchema.optional(),
    input: UnknownRecordSchema.optional(),
    item: z
      .object({
        id: NonEmptyStringSchema.optional(),
        name: NonEmptyStringSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ToolResultNotificationSchema = z
  .object({
    toolUseId: NonEmptyStringSchema.optional(),
    output: z.string().optional(),
    item: z
      .object({
        toolUseId: NonEmptyStringSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const CanonicalRequestIdFromFieldSchema = z.object({
  requestId: NonEmptyStringSchema,
});

const CanonicalRequestIdFromItemIdSchema = z.object({
  itemId: NonEmptyStringSchema,
});

const CanonicalRequestIdFromNestedItemSchema = z.object({
  item: z.object({
    id: NonEmptyStringSchema,
  }),
});

const RawUserInputQuestionOptionSchema = z
  .object({
    label: z.unknown().optional(),
    description: z.unknown().optional(),
  })
  .passthrough();

const RawUserInputQuestionSchema = z
  .object({
    header: z.unknown().optional(),
    question: z.unknown().optional(),
    options: z.array(RawUserInputQuestionOptionSchema).optional(),
  })
  .passthrough();

const RawUserInputRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
    item: z
      .object({
        prompt: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    questions: z.array(RawUserInputQuestionSchema).optional(),
  })
  .passthrough();

export interface CodexUserInputQuestionOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  header: string;
  question: string;
  options: CodexUserInputQuestionOption[];
}

export interface CodexParsedToolCallNotification {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface CodexParsedToolResultNotification {
  toolUseId: string;
  output: string | null;
  payload: Record<string, unknown>;
}

type CodexRequestParamValidationResult =
  | { success: true; data: unknown }
  | { success: false; issues: z.ZodIssue[] };

type CodexApprovalResponseValidationResult =
  | {
      success: true;
      data: { decision: 'accept' | 'decline' };
    }
  | { success: false; issues: z.ZodIssue[] };

type CodexUserInputResponseValidationResult =
  | {
      success: true;
      data: {
        answers: Record<string, { answers: string[] }>;
      };
    }
  | { success: false; issues: z.ZodIssue[] };

const DEFAULT_USER_INPUT_OPTIONS: CodexUserInputQuestionOption[] = [
  {
    label: 'Continue',
    description: 'Provide an answer and continue execution.',
  },
  {
    label: 'Cancel',
    description: 'Decline and stop this request.',
  },
];

const ThreadIdFromFieldSchema = z.object({
  threadId: NonEmptyStringSchema,
});

const ThreadIdFromNestedSchema = z.object({
  thread: z.object({
    id: NonEmptyStringSchema,
  }),
});

const TurnIdFromFieldSchema = z.object({
  turnId: NonEmptyStringSchema,
});

const TurnIdFromNestedSchema = z.object({
  turn: z.object({
    id: NonEmptyStringSchema,
  }),
});

export function parseThreadIdWithSchema(value: unknown): string | null {
  const direct = ThreadIdFromFieldSchema.safeParse(value);
  if (direct.success) {
    return direct.data.threadId;
  }

  const nested = ThreadIdFromNestedSchema.safeParse(value);
  if (nested.success) {
    return nested.data.thread.id;
  }

  return null;
}

export function parseTurnIdWithSchema(value: unknown): string | null {
  const direct = TurnIdFromFieldSchema.safeParse(value);
  if (direct.success) {
    return direct.data.turnId;
  }

  const nested = TurnIdFromNestedSchema.safeParse(value);
  if (nested.success) {
    return nested.data.turn.id;
  }

  return null;
}

export function parseCanonicalRequestIdWithSchema(
  serverRequestId: string | number,
  params: unknown
): string {
  const direct = CanonicalRequestIdFromFieldSchema.safeParse(params);
  if (direct.success) {
    return direct.data.requestId;
  }

  const itemId = CanonicalRequestIdFromItemIdSchema.safeParse(params);
  if (itemId.success) {
    return itemId.data.itemId;
  }

  const nested = CanonicalRequestIdFromNestedItemSchema.safeParse(params);
  if (nested.success) {
    return nested.data.item.id;
  }

  return `codex-request-${String(serverRequestId)}`;
}

export function parseTransportErrorWithSchema(error: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  const parsed = CodexTransportErrorSchema.safeParse(error);
  if (parsed.success) {
    return parsed.data;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === 'number' ? record.code : -1,
      message:
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : 'Unknown Codex app-server error',
      ...(Object.hasOwn(record, 'data') ? { data: record.data } : {}),
    };
  }

  return { code: -1, message: String(error) };
}

function toOption(
  option: z.infer<typeof RawUserInputQuestionOptionSchema>
): CodexUserInputQuestionOption {
  return {
    label: typeof option.label === 'string' && option.label.length > 0 ? option.label : 'Option',
    description: typeof option.description === 'string' ? option.description : '',
  };
}

function getDefaultPrompt(parsed: z.infer<typeof RawUserInputRequestSchema> | null): string {
  if (typeof parsed?.prompt === 'string' && parsed.prompt.length > 0) {
    return parsed.prompt;
  }
  if (typeof parsed?.item?.prompt === 'string' && parsed.item.prompt.length > 0) {
    return parsed.item.prompt;
  }
  return 'Provide input';
}

export function parseUserInputQuestionsWithSchema(params: unknown): CodexUserInputQuestion[] {
  const parsed = RawUserInputRequestSchema.safeParse(params);
  const prompt = getDefaultPrompt(parsed.success ? parsed.data : null);
  if (!(parsed.success && parsed.data.questions) || parsed.data.questions.length === 0) {
    return [
      {
        header: 'Codex Input',
        question: prompt,
        options: DEFAULT_USER_INPUT_OPTIONS,
      },
    ];
  }

  return parsed.data.questions.map((question) => {
    const options =
      question.options && question.options.length > 0
        ? question.options.map((option) => toOption(option))
        : DEFAULT_USER_INPUT_OPTIONS;

    return {
      header:
        typeof question.header === 'string' && question.header.length > 0
          ? question.header
          : 'Codex Input',
      question:
        typeof question.question === 'string' && question.question.length > 0
          ? question.question
          : prompt,
      options,
    };
  });
}

export function validateCodexRequestParamsWithSchema(
  method: string,
  params: unknown
): CodexRequestParamValidationResult {
  const schema = CodexRequestParamSchemas[method as keyof typeof CodexRequestParamSchemas];
  if (!schema) {
    return { success: true, data: params };
  }

  const parsed = schema.safeParse(params);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, issues: parsed.error.issues };
}

export function parseNotificationTextWithSchema(params: unknown): string | null {
  const direct = NotificationTextDirectSchema.safeParse(params);
  if (direct.success) {
    const directText = direct.data.text ?? direct.data.delta ?? direct.data.chunk;
    if (directText) {
      return directText;
    }
  }

  const nested = NotificationTextNestedSchema.safeParse(params);
  if (!(nested.success && nested.data.item)) {
    return null;
  }

  const nestedText = nested.data.item.text ?? nested.data.item.delta ?? nested.data.item.content;
  if (nestedText) {
    return nestedText;
  }

  const messageContent = nested.data.item.message?.content ?? [];
  for (const contentBlock of messageContent) {
    if (contentBlock.text) {
      return contentBlock.text;
    }
  }

  return null;
}

export function parseToolCallNotificationWithSchema(
  params: unknown
): CodexParsedToolCallNotification {
  const parsed = ToolCallNotificationSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolUseId: 'codex-tool',
      toolName: 'codex_tool',
      input: {},
    };
  }

  return {
    toolUseId: parsed.data.toolUseId ?? parsed.data.item?.id ?? 'codex-tool',
    toolName: parsed.data.toolName ?? parsed.data.item?.name ?? 'codex_tool',
    input: parsed.data.input ?? {},
  };
}

export function parseToolResultNotificationWithSchema(
  params: unknown
): CodexParsedToolResultNotification {
  const record = UnknownRecordSchema.safeParse(params);
  const payload = record.success ? record.data : {};
  const parsed = ToolResultNotificationSchema.safeParse(params);
  if (!parsed.success) {
    return {
      toolUseId: 'codex-tool',
      output: null,
      payload,
    };
  }

  return {
    toolUseId: parsed.data.toolUseId ?? parsed.data.item?.toolUseId ?? 'codex-tool',
    output: parsed.data.output ?? null,
    payload,
  };
}

export function validateCodexApprovalResponseWithSchema(
  method: string,
  response: unknown
): CodexApprovalResponseValidationResult {
  const schema =
    method === 'item/fileChange/requestApproval'
      ? CodexFileChangeRequestApprovalResponseSchema
      : CodexCommandExecutionRequestApprovalResponseSchema;
  const parsed = schema.safeParse(response);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, issues: parsed.error.issues };
}

export function validateCodexToolRequestUserInputResponseWithSchema(
  response: unknown
): CodexUserInputResponseValidationResult {
  const parsed = CodexToolRequestUserInputResponseSchema.safeParse(response);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, issues: parsed.error.issues };
}
