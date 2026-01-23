import { inngest } from "../client.js";
import { mailAccessor } from "../../resource_accessors/index.js";
import { notificationService } from "../../services/notification.service.js";

/**
 * Handle mail.sent event
 *
 * This is triggered whenever an agent sends mail.
 * If the mail is for a human, it triggers a desktop notification.
 */
export const mailSentHandler = inngest.createFunction(
  {
    id: "mail-sent",
    name: "Handle Mail Sent",
    retries: 2,
  },
  { event: "mail.sent" },
  async ({ event, step }) => {
    const { mailId, toAgentId, isForHuman, subject } = event.data;

    console.log("Mail sent event received:", {
      mailId,
      toAgentId: toAgentId || "(none)",
      isForHuman,
      subject,
    });

    // Step 1: Get full mail details
    const mail = await step.run("get-mail-details", async () => {
      const mail = await mailAccessor.findById(mailId);
      if (!mail) {
        console.warn(`Mail ${mailId} not found`);
        return null;
      }
      return {
        id: mail.id,
        subject: mail.subject,
        body: mail.body,
        isForHuman: mail.isForHuman,
        fromAgentId: mail.fromAgentId,
        toAgentId: mail.toAgentId,
      };
    });

    if (!mail) {
      return { processed: false, reason: "Mail not found" };
    }

    // Step 2: If mail is for human, send desktop notification
    if (mail.isForHuman) {
      await step.run("send-notification", async () => {
        console.log(`Sending desktop notification for mail: ${mail.subject}`);

        // Truncate body for notification (notifications have limited space)
        const truncatedBody = mail.body.length > 200
          ? mail.body.substring(0, 197) + "..."
          : mail.body;

        await notificationService.notifyHuman(
          mail.subject,
          truncatedBody
        );

        return { notificationSent: true };
      });
    }

    return {
      processed: true,
      mailId,
      isForHuman: mail.isForHuman,
      notificationSent: mail.isForHuman,
    };
  }
);
