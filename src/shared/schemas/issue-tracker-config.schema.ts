import { z } from 'zod';

export const LinearConfigSchema = z.object({
  apiKey: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  viewerName: z.string(),
});

export const IssueTrackerConfigSchema = z.object({
  linear: LinearConfigSchema.optional(),
});

export type IssueTrackerConfig = z.infer<typeof IssueTrackerConfigSchema>;
export type LinearConfig = z.infer<typeof LinearConfigSchema>;

/** Config shape returned to the client — apiKey replaced with hasApiKey boolean */
export const PublicLinearConfigSchema = LinearConfigSchema.omit({ apiKey: true }).extend({
  hasApiKey: z.boolean(),
});

export const PublicIssueTrackerConfigSchema = z.object({
  linear: PublicLinearConfigSchema.optional(),
});

export type PublicIssueTrackerConfig = z.infer<typeof PublicIssueTrackerConfigSchema>;
export type PublicLinearConfig = z.infer<typeof PublicLinearConfigSchema>;

/** Strip the encrypted API key from the config, replacing it with a boolean */
export function sanitizeIssueTrackerConfig(raw: unknown): PublicIssueTrackerConfig | null {
  const parsed = IssueTrackerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { linear } = parsed.data;
  if (!linear) {
    return {};
  }
  const { apiKey, ...rest } = linear;
  return { linear: { ...rest, hasApiKey: !!apiKey } };
}
