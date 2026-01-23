import { z } from 'zod';
import { inngest } from '../inngest/client';
import { mailAccessor } from '../resource_accessors/mail.accessor';
import { publicProcedure, router } from './trpc';

export const mailRouter = router({
  // List human inbox
  listHumanInbox: publicProcedure
    .input(
      z
        .object({
          includeRead: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return mailAccessor.listHumanInbox(input?.includeRead ?? true);
    }),

  // Get mail by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const mail = await mailAccessor.findById(input.id);
    if (!mail) {
      throw new Error(`Mail not found: ${input.id}`);
    }

    // Mark as read when viewed
    if (!mail.isRead) {
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

  // Get unread count for human inbox
  getUnreadCount: publicProcedure.query(async () => {
    const unreadMail = await mailAccessor.listHumanInbox(false);
    return { count: unreadMail.length };
  }),
});
