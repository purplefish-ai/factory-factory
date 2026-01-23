import { inngest } from "../client.js";

/**
 * Handle mail.sent event
 * This is triggered whenever an agent sends mail
 */
export const mailSentHandler = inngest.createFunction(
  { id: "mail-sent", name: "Handle Mail Sent" },
  { event: "mail.sent" },
  async ({ event, step }) => {
    const { mailId, toAgentId, isForHuman, subject } = event.data;

    // Log the event
    await step.run("log-mail-sent", async () => {
      console.log("📧 Mail sent event received:", {
        mailId,
        toAgentId: toAgentId || "(none)",
        isForHuman,
        subject,
      });

      // Future: Trigger notifications here
      // Future: If mail is for human, send email/slack notification
      // Future: If mail is for agent, wake up the agent if needed

      return { processed: true };
    });
  }
);
