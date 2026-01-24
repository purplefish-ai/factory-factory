import type { Agent, Mail } from '@prisma-gen/client';
import { z } from 'zod';
import { inngest } from '../../inngest/client.js';
import { mailAccessor } from '../../resource_accessors/index.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

// Mail with included fromAgent relation
type MailWithFromAgent = Mail & { fromAgent: Agent | null };

// ============================================================================
// Input Schemas
// ============================================================================

const ListInboxInputSchema = z.object({
  includeRead: z.boolean().optional().default(false),
});

const ReadMailInputSchema = z.object({
  mailId: z.string(),
});

const SendMailInputSchema = z.object({
  toAgentId: z.string().optional(),
  toHuman: z.boolean().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const ReplyMailInputSchema = z.object({
  originalMailId: z.string(),
  body: z.string().min(1),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List inbox for the current agent
 */
async function listInbox(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = ListInboxInputSchema.parse(input);
    const { includeRead } = parsed;

    const mails = await mailAccessor.listInbox(context.agentId, includeRead);

    const unreadCount = mails.filter((m) => !m.isRead).length;

    return createSuccessResponse({
      count: mails.length,
      unreadCount,
      mails: mails.map((mail) => ({
        id: mail.id,
        fromAgentId: mail.fromAgentId ?? undefined,
        fromAgentType: (mail as MailWithFromAgent).fromAgent?.type,
        subject: mail.subject,
        body: mail.body,
        isRead: mail.isRead,
        createdAt: mail.createdAt,
        readAt: mail.readAt ?? undefined,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Read a specific mail and mark it as read
 */
async function readMail(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = ReadMailInputSchema.parse(input);
    const { mailId } = parsed;

    // Fetch the mail
    const mail = await mailAccessor.findById(mailId);

    if (!mail) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Mail with ID '${mailId}' not found`
      );
    }

    // Verify the mail belongs to the current agent
    if (mail.toAgentId !== context.agentId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'You do not have permission to read this mail'
      );
    }

    // Mark as read if not already
    let updatedMail = mail;
    if (!mail.isRead) {
      updatedMail = await mailAccessor.markAsRead(mailId);
    }

    return createSuccessResponse({
      id: updatedMail.id,
      fromAgentId: updatedMail.fromAgentId ?? undefined,
      fromAgentType: (updatedMail as MailWithFromAgent).fromAgent?.type,
      subject: updatedMail.subject,
      body: updatedMail.body,
      isRead: updatedMail.isRead,
      createdAt: updatedMail.createdAt,
      readAt: updatedMail.readAt ?? undefined,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Send mail to another agent or to human
 */
async function sendMail(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = SendMailInputSchema.parse(input);
    const { toAgentId, toHuman, subject, body } = parsed;

    // Validate: must specify either toAgentId or toHuman
    if (!(toAgentId || toHuman)) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        "Must specify either 'toAgentId' or 'toHuman: true'"
      );
    }

    if (toAgentId && toHuman) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        "Cannot specify both 'toAgentId' and 'toHuman'"
      );
    }

    // Create mail
    const mail = await mailAccessor.create({
      fromAgentId: context.agentId,
      toAgentId: toAgentId,
      isForHuman: toHuman ?? false,
      subject,
      body,
    });

    // Fire Inngest event
    await inngest.send({
      name: 'mail.sent',
      data: {
        mailId: mail.id,
        toAgentId: mail.toAgentId ?? undefined,
        isForHuman: mail.isForHuman,
        subject: mail.subject,
      },
    });

    return createSuccessResponse({
      mailId: mail.id,
      timestamp: mail.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Reply to a received mail
 */
async function replyMail(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = ReplyMailInputSchema.parse(input);
    const { originalMailId, body } = parsed;

    // Fetch original mail
    const originalMail = await mailAccessor.findById(originalMailId);

    if (!originalMail) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Original mail with ID '${originalMailId}' not found`
      );
    }

    // Verify the current agent received the original mail
    if (originalMail.toAgentId !== context.agentId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'You can only reply to mail you received'
      );
    }

    // Determine recipient (sender of original mail)
    const recipientAgentId = originalMail.fromAgentId;
    const isForHuman = !recipientAgentId;

    // Create reply subject
    const replySubject = originalMail.subject.startsWith('Re: ')
      ? originalMail.subject
      : `Re: ${originalMail.subject}`;

    // Create reply mail
    const replyMail = await mailAccessor.create({
      fromAgentId: context.agentId,
      toAgentId: recipientAgentId ?? undefined,
      isForHuman,
      subject: replySubject,
      body,
    });

    // Fire Inngest event
    await inngest.send({
      name: 'mail.sent',
      data: {
        mailId: replyMail.id,
        toAgentId: replyMail.toAgentId ?? undefined,
        isForHuman: replyMail.isForHuman,
        subject: replyMail.subject,
      },
    });

    return createSuccessResponse({
      mailId: replyMail.id,
      timestamp: replyMail.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerMailTools(): void {
  registerMcpTool({
    name: 'mcp__mail__list_inbox',
    description: "List mail in the agent's inbox",
    handler: listInbox,
    schema: ListInboxInputSchema,
  });

  registerMcpTool({
    name: 'mcp__mail__read',
    description: 'Read a specific mail and mark it as read',
    handler: readMail,
    schema: ReadMailInputSchema,
  });

  registerMcpTool({
    name: 'mcp__mail__send',
    description: 'Send mail to another agent or to a human',
    handler: sendMail,
    schema: SendMailInputSchema,
  });

  registerMcpTool({
    name: 'mcp__mail__reply',
    description: 'Reply to a received mail',
    handler: replyMail,
    schema: ReplyMailInputSchema,
  });
}
