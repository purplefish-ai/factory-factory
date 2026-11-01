import { z } from 'zod';

const id = z.string().min(1).max(256);
const index = z.number().int().nonnegative().max(2_147_483_647);
export const agentSourcePageNumberSchema = z.number().int().positive().max(2_147_483_647);
export const agentSourceScanSchema = z.strictObject({
  id,
  fixedHeadEventId: id,
  previousBoundaryEventId: id.nullable(),
  phase: z.enum(['CAPTURE', 'VERIFY', 'FINALIZE']),
  nextPage: agentSourcePageNumberSchema,
  observationCount: index,
  verifiedCount: index,
  finalizedCount: index,
  resumePage: agentSourcePageNumberSchema,
  resumeIds: z.array(id).max(100),
  overlapOffset: index.nullable(),
  verifyResumeCount: index,
  verifySeekingOverlap: z.boolean().default(false),
});
export const agentGithubCursorSchema = z.strictObject({
  version: z.literal(1),
  provider: z.literal('GITHUB'),
  committedHeadEventId: id.nullable(),
  scan: agentSourceScanSchema.nullable(),
});
export const agentSourcePageEvidenceSchema = z.strictObject({
  ids: z.array(id).max(100),
  entries: z.array(z.strictObject({ providerEventId: id, eventId: id.nullable() })).max(100),
});
export type AgentSourceScan = z.infer<typeof agentSourceScanSchema>;
export type AgentGithubCursor = z.infer<typeof agentGithubCursorSchema>;
export type AgentSourceEntry = z.infer<typeof agentSourcePageEvidenceSchema>['entries'][number];
