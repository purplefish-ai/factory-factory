import { z } from 'zod';

const requestIdSchema = z.union([z.string(), z.number(), z.null()]);

const codexErrorSchema = z
  .object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const codexRpcResponseSchema = z
  .object({
    id: requestIdSchema,
    result: z.unknown().optional(),
    error: codexErrorSchema.optional(),
  })
  .passthrough();

export const codexRpcServerRequestSchema = z
  .object({
    id: requestIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();

export const codexRpcNotificationEnvelopeSchema = z
  .object({
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();

const threadItemSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .passthrough();

const userInputTextSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const userMessageThreadItemSchema = z
  .object({
    type: z.literal('userMessage'),
    id: z.string(),
    content: z.array(userInputTextSchema),
  })
  .passthrough();

const agentMessageThreadItemSchema = z
  .object({
    type: z.literal('agentMessage'),
    id: z.string(),
    text: z.string(),
  })
  .passthrough();

const codexThreadStatusSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const codexTurnStatusSchema = z.string().min(1);

export function isKnownCodexTurnStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'interrupted' ||
    status === 'failed' ||
    status === 'inProgress'
  );
}

export const subAgentActivityItemSchema = threadItemSchema
  .extend({
    type: z.literal('subAgentActivity'),
    agentThreadId: z.string().min(1),
    agentPath: z.string(),
    kind: z.enum(['started', 'interacted', 'interrupted']),
  })
  .passthrough();

export const collabAgentToolCallItemSchema = threadItemSchema
  .extend({
    type: z.literal('collabAgentToolCall'),
    tool: z.string(),
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string().min(1)),
    status: z.string(),
  })
  .passthrough();

const turnSchema = z
  .object({
    id: z.string(),
    status: codexTurnStatusSchema,
    error: z
      .object({
        message: z.string(),
      })
      .nullable()
      .optional(),
    items: z.array(threadItemSchema).optional(),
  })
  .passthrough();

const itemStartedNotificationSchema = z.object({
  method: z.literal('item/started'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: threadItemSchema,
  }),
});

const itemCompletedNotificationSchema = z.object({
  method: z.literal('item/completed'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: threadItemSchema,
  }),
});

const agentMessageDeltaNotificationSchema = z.object({
  method: z.literal('item/agentMessage/delta'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});

const planDeltaNotificationSchema = z.object({
  method: z.literal('item/plan/delta'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});

const reasoningSummaryTextDeltaNotificationSchema = z.object({
  method: z.literal('item/reasoning/summaryTextDelta'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});

const commandOutputDeltaNotificationSchema = z.object({
  method: z.literal('item/commandExecution/outputDelta'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});

const fileChangeOutputDeltaNotificationSchema = z.object({
  method: z.literal('item/fileChange/outputDelta'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});

const mcpToolCallProgressNotificationSchema = z.object({
  method: z.literal('item/mcpToolCall/progress'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    message: z.string(),
  }),
});

const turnCompletedNotificationSchema = z.object({
  method: z.literal('turn/completed'),
  params: z.object({
    threadId: z.string(),
    turn: turnSchema,
  }),
});

const turnStartedNotificationSchema = z.object({
  method: z.literal('turn/started'),
  params: z.object({
    threadId: z.string(),
    turn: turnSchema,
  }),
});

const errorNotificationSchema = z.object({
  method: z.literal('error'),
  params: z
    .object({
      message: z.string().optional(),
    })
    .passthrough(),
});

export const threadStatusChangedNotificationSchema = z
  .object({
    method: z.literal('thread/status/changed'),
    params: z
      .object({
        threadId: z.string(),
        status: codexThreadStatusSchema,
      })
      .passthrough(),
  })
  .passthrough();

export const knownCodexNotificationSchema = z.union([
  itemStartedNotificationSchema,
  itemCompletedNotificationSchema,
  agentMessageDeltaNotificationSchema,
  planDeltaNotificationSchema,
  reasoningSummaryTextDeltaNotificationSchema,
  commandOutputDeltaNotificationSchema,
  fileChangeOutputDeltaNotificationSchema,
  mcpToolCallProgressNotificationSchema,
  turnCompletedNotificationSchema,
  turnStartedNotificationSchema,
  errorNotificationSchema,
  threadStatusChangedNotificationSchema,
]);

export const commandExecutionApprovalRequestSchema = z.object({
  id: requestIdSchema,
  method: z.literal('item/commandExecution/requestApproval'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    reason: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    callId: z.string().nullable().optional(),
    call_id: z.string().nullable().optional(),
    commandActions: z.unknown().optional(),
    proposedExecpolicyAmendment: z.unknown().optional(),
  }),
});

export const fileChangeApprovalRequestSchema = z.object({
  id: requestIdSchema,
  method: z.literal('item/fileChange/requestApproval'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
    callId: z.string().nullable().optional(),
    call_id: z.string().nullable().optional(),
  }),
});

export const toolUserInputRequestSchema = z.object({
  id: requestIdSchema,
  method: z.literal('item/tool/requestUserInput'),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    callId: z.string().nullable().optional(),
    call_id: z.string().nullable().optional(),
    questions: z.array(
      z.object({
        id: z.string(),
        header: z.string(),
        question: z.string(),
        isOther: z.boolean(),
        isSecret: z.boolean(),
        options: z
          .array(
            z.object({
              label: z.string(),
              description: z.string(),
            })
          )
          .nullable(),
      })
    ),
  }),
});

export const knownCodexServerRequestSchema = z.union([
  commandExecutionApprovalRequestSchema,
  fileChangeApprovalRequestSchema,
  toolUserInputRequestSchema,
]);

export const threadStartResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        cwd: z.string().optional(),
      })
      .passthrough(),
    model: z.string().optional(),
    approvalPolicy: z.string().optional(),
    sandbox: z.unknown().optional(),
    reasoningEffort: z.string().nullable().optional(),
  })
  .passthrough();

export const threadResumeResponseSchema = threadStartResponseSchema;

export const threadReadTurnSchema = z
  .object({
    id: z.string(),
    status: codexTurnStatusSchema.optional(),
    startedAt: z.number().nullable().optional(),
    completedAt: z.number().nullable().optional(),
    items: z.array(
      z.union([
        userMessageThreadItemSchema,
        agentMessageThreadItemSchema,
        subAgentActivityItemSchema,
        collabAgentToolCallItemSchema,
        threadItemSchema,
      ])
    ),
  })
  .passthrough();

const threadListItemSchema = z
  .object({
    id: z.string(),
    parentThreadId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    agentNickname: z.string().nullable().optional(),
    preview: z.string().optional(),
    createdAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
    status: codexThreadStatusSchema.optional(),
    turns: z.array(threadReadTurnSchema).optional(),
  })
  .passthrough();

export const threadListResponseSchema = z
  .object({
    data: z.array(threadListItemSchema),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

export const threadReadResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        turns: z.array(threadReadTurnSchema),
      })
      .passthrough(),
  })
  .passthrough();

export const turnStartResponseSchema = z
  .object({
    turn: z
      .object({
        id: z.string(),
        status: codexTurnStatusSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const modelListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          displayName: z.string(),
          description: z.string(),
          supportedReasoningEfforts: z
            .array(
              z
                .object({
                  reasoningEffort: z.string(),
                  description: z.string().nullable().optional(),
                })
                .passthrough()
            )
            .optional(),
          defaultReasoningEffort: z.string().nullable().optional(),
          inputModalities: z.array(z.string()).optional(),
          isDefault: z.boolean().optional(),
        })
        .passthrough()
    ),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

export const collaborationModeListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          name: z.string(),
          mode: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
          reasoning_effort: z.string().nullable().optional(),
          developer_instructions: z.string().nullable().optional(),
        })
        .passthrough()
    ),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

export const configRequirementsReadResponseSchema = z
  .object({
    requirements: z
      .object({
        allowedApprovalPolicies: z.array(z.string()).nullable().optional(),
        allowedSandboxModes: z.array(z.string()).nullable().optional(),
        allowedWebSearchModes: z.array(z.string()).nullable().optional(),
        enforceResidency: z.unknown().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type CodexRpcResponse = z.infer<typeof codexRpcResponseSchema>;
export type CodexRpcServerRequest = z.infer<typeof codexRpcServerRequestSchema>;
export type CodexKnownNotification = z.infer<typeof knownCodexNotificationSchema>;
export type CodexKnownServerRequest = z.infer<typeof knownCodexServerRequestSchema>;
export type ThreadStartResponse = z.infer<typeof threadStartResponseSchema>;
export type ThreadResumeResponse = z.infer<typeof threadResumeResponseSchema>;
export type ThreadReadResponse = z.infer<typeof threadReadResponseSchema>;
export type ThreadReadTurn = z.infer<typeof threadReadTurnSchema>;
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;
export type TurnStartResponse = z.infer<typeof turnStartResponseSchema>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;
export type CollaborationModeListResponse = z.infer<typeof collaborationModeListResponseSchema>;
export type ConfigRequirementsReadResponse = z.infer<typeof configRequirementsReadResponseSchema>;
