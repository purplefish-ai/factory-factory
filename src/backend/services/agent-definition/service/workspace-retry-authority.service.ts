import { z } from 'zod';
import { workspaceRetryAuthorityAccessor } from '@/backend/services/agent-definition/resources/workspace-retry-authority.accessor';
const targetSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
});
export const workspaceRetryAuthorityService = {
  read: (input: unknown) => workspaceRetryAuthorityAccessor.read(targetSchema.parse(input)),
};
