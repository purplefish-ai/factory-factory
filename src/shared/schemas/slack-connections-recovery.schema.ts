import { z } from 'zod';

export const slackConnectionsRecoverySchema = z
  .strictObject({
    version: z.literal(1),
    connections: z.array(
      z.strictObject({
        id: z
          .string()
          .refine((value) => value.trim().length > 0, 'Connection ID must not be blank'),
        provider: z.literal('SLACK'),
        externalId: z
          .string()
          .refine((value) => value.trim().length > 0, 'Workspace ID must not be blank'),
        name: z.string().min(1),
        isEnabled: z.boolean(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
    ),
  })
  .superRefine((section, ctx) => {
    const ids = new Set<string>();
    const externalIds = new Set<string>();
    section.connections.forEach((row, index) => {
      for (const [field, seen] of [
        ['id', ids],
        ['externalId', externalIds],
      ] as const) {
        if (seen.has(row[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['connections', index, field],
            message: 'Duplicate Slack connection identity',
          });
        }
        seen.add(row[field]);
      }
    });
  });
export type SlackConnectionsRecovery = z.infer<typeof slackConnectionsRecoverySchema>;
