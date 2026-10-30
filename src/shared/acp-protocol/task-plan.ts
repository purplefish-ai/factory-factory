import { z } from 'zod';

const acpPlanNotificationSchema = z.object({
  type: z.literal('acp_plan'),
  entries: z.array(
    z.object({
      content: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      priority: z.enum(['high', 'medium', 'low']),
    })
  ),
});

export type AcpPlanNotification = z.infer<typeof acpPlanNotificationSchema>;

/** Task notifications also carry plain-text subagent notices. */
export function parseAcpPlanNotification(message: string | undefined): AcpPlanNotification | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = acpPlanNotificationSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
