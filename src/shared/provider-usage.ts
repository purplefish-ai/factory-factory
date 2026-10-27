import { z } from 'zod';

export const usageProviderSchema = z.enum(['CLAUDE', 'CODEX']);

export const providerPlanUsageSchema = z.object({
  provider: usageProviderSchema,
  status: z.enum(['available', 'unavailable', 'error']),
  windows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      usedPercent: z.number().finite().min(0).max(100),
      resetsAt: z.number().finite().nonnegative().nullable(),
    })
  ),
  updatedAt: z.string().datetime(),
  message: z.string().optional(),
});

export type UsageProvider = z.infer<typeof usageProviderSchema>;
export type ProviderPlanUsage = z.infer<typeof providerPlanUsageSchema>;
