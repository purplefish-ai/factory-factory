import { z } from 'zod';
import {
  agentDefinitionRevisionSchema,
  agentExecutionConfigSchema,
} from './agent-definition.schema';

const executionConfig = z.unknown().transform((raw, ctx) => {
  const parsed = agentExecutionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue });
    }
    return z.NEVER;
  }
  const original = z.record(z.string(), z.unknown()).parse(raw);
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    if (
      Object.hasOwn(original, key) &&
      (original[key] === undefined || original[key] !== parsed.data[key])
    ) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Noncanonical execution preference' });
    }
  }
  return parsed.data;
});

export const automationDefinitionsRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    definitions: z.array(
      z.strictObject({
        id: z.string(),
        projectId: z.string(),
        name: z.string(),
        instructions: z.string(),
        isEnabled: z.boolean(),
        executionConfig,
        definitionRevision: agentDefinitionRevisionSchema,
        managementRevision: agentDefinitionRevisionSchema,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
    ),
  })
  .superRefine((section, ctx) => {
    const ids = new Set<string>();
    section.definitions.forEach((row, index) => {
      if (ids.has(row.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['definitions', index, 'id'],
          message: 'Duplicate automation definition identity',
        });
      }
      ids.add(row.id);
    });
  });
export type AutomationDefinitionsRecovery = z.infer<typeof automationDefinitionsRecoverySchema>;
