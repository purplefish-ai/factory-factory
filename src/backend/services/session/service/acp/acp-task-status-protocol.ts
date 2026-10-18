import { z } from 'zod';

export const TASK_STATUS_CHANGED_METHOD = 'factoryfactory.ai/task/status-changed';

export const taskStatusChangedParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    active: z.boolean(),
  })
  .passthrough();

export type TaskStatusChangedParams = z.infer<typeof taskStatusChangedParamsSchema>;
