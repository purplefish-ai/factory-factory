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
