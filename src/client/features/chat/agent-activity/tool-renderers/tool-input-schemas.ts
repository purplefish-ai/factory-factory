import { z } from 'zod';
import { todoSchema } from '@/client/features/chat/use-todo-tracker';

/**
 * Tool input comes from the agent and is untrusted. Renderers read it through
 * these schemas; a mismatch returns null and the caller shows the raw JSON.
 */
export function parseToolInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): z.infer<Schema> | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}

export const taskToolInputSchema = z.object({
  subagent_type: z.string().nullish(),
  description: z.string().nullish(),
  prompt: z.string().nullish(),
});

/**
 * A missing list is an empty task list; a malformed one, including `null`,
 * falls back to raw JSON, as `use-todo-tracker` also rejects it.
 */
export const todoWriteToolInputSchema = z.object({
  todos: z.array(todoSchema).optional(),
});

export const readToolInputSchema = z.object({
  file_path: z.string().nullish(),
  offset: z.number().nullish(),
  limit: z.number().nullish(),
});

export const writeToolInputSchema = z.object({
  file_path: z.string().nullish(),
  content: z.string().nullish(),
});

export const editToolInputSchema = z.object({
  file_path: z.string().nullish(),
  old_string: z.string().nullish(),
  new_string: z.string().nullish(),
});
