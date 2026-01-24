import { z } from 'zod';
import { inngest } from '../inngest/client';
import { mailAccessor } from '../resource_accessors/mail.accessor';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc';

export const mailRouter = router({
  // List human inbox (scoped to project from context)
  listHumanInbox: projectScopedProcedure
    .input(
      z
        .object({
          includeRead: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return mailAccessor.listHumanInbox(input?.includeRead ?? true, ctx.projectId);
    }),

  // List all mail in the system (scoped to project from context)
  listAll: projectScopedProcedure
    .input(
      z
        .object({
          includeRead: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return mailAccessor.listAll(input?.includeRead ?? true, ctx.projectId);
    }),

  // List inbox for a specific agent
  listAgentInbox: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
        includeRead: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      return mailAccessor.listInbox(input.agentId, input.includeRead ?? true);
    }),

  // Get mail by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const mail = await mailAccessor.findById(input.id);
    if (!mail) {
      throw new Error(`Mail not found: ${input.id}`);
    }

    // Only mark as read if mail is for human (don't mark agent-to-agent mail)
    if (!mail.isRead && mail.isForHuman) {
      await mailAccessor.markAsRead(input.id);
    }

    return mail;
  }),

  // Send mail to an agent (from human)
  sendToAgent: publicProcedure
    .input(
      z.object({
        toAgentId: z.string(),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const mail = await mailAccessor.create({
        toAgentId: input.toAgentId,
        isForHuman: false,
        subject: input.subject,
        body: input.body,
      });

      // Fire mail.sent event
      await inngest.send({
        name: 'mail.sent',
        data: {
          mailId: mail.id,
          fromAgentId: null,
          toAgentId: input.toAgentId,
          isForHuman: false,
          subject: input.subject,
        },
      });

      return mail;
    }),

  // Reply to a mail (from human)
  reply: publicProcedure
    .input(
      z.object({
        inReplyToMailId: z.string(),
        body: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const originalMail = await mailAccessor.findById(input.inReplyToMailId);
      if (!originalMail) {
        throw new Error(`Original mail not found: ${input.inReplyToMailId}`);
      }

      // Reply to the sender
      const toAgentId = originalMail.fromAgentId;
      if (!toAgentId) {
        throw new Error('Cannot reply: original mail has no sender agent');
      }

      const mail = await mailAccessor.create({
        toAgentId,
        isForHuman: false,
        subject: `Re: ${originalMail.subject}`,
        body: input.body,
      });

      // Fire mail.sent event
      await inngest.send({
        name: 'mail.sent',
        data: {
          mailId: mail.id,
          fromAgentId: null,
          toAgentId,
          isForHuman: false,
          subject: mail.subject,
        },
      });

      return mail;
    }),

  // Mark mail as read
  markAsRead: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    return mailAccessor.markAsRead(input.id);
  }),

  // Get unread count for human inbox (scoped to project from context)
  getUnreadCount: projectScopedProcedure.query(async ({ ctx }) => {
    const unreadMail = await mailAccessor.listHumanInbox(false, ctx.projectId);
    return { count: unreadMail.length };
  }),
});
