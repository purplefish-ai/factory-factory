import { z } from 'zod';

export const baseJsonSectionSchema = z.strictObject({
  version: z.literal(1),
  jsonStorage: z.array(
    z.discriminatedUnion('model', [
      z.strictObject({
        model: z.literal('Workspace'),
        identity: z.tuple([z.string()]),
        field: z.literal('creationMetadata'),
      }),
      z.strictObject({
        model: z.literal('WorkspacePR'),
        identity: z.tuple([z.string().min(1)]),
        field: z.literal('observation'),
      }),
      z.strictObject({
        model: z.literal('AgentSession'),
        identity: z.tuple([z.string()]),
        field: z.literal('providerMetadata'),
      }),
    ])
  ),
});
export type BaseJsonSection = z.infer<typeof baseJsonSectionSchema>;
export function validateBaseJsonTargets(
  data: {
    workspaces: {
      id: string;
      creationMetadata?: unknown;
      prs: { id: string; observation?: unknown }[];
    }[];
    agentSessions: { id: string; providerMetadata?: unknown }[];
  },
  section: BaseJsonSection,
  full: boolean,
  ctx: z.RefinementCtx
): void {
  const targets = new Map<string, unknown[]>();
  const add = (
    model: string,
    row: { id: string },
    field: string,
    value: unknown,
    path: (string | number)[]
  ) => {
    const key = JSON.stringify([model, row.id, field]);
    const values = targets.get(key) ?? [];
    values.push(value);
    targets.set(key, values);
    if (!Object.hasOwn(row, field) || value === undefined) {
      ctx.addIssue({ code: 'custom', message: `Covered ${field} must be present`, path });
    }
  };
  for (const [i, workspace] of data.workspaces.entries()) {
    add('Workspace', workspace, 'creationMetadata', workspace.creationMetadata, [
      'data',
      'workspaces',
      i,
      'creationMetadata',
    ]);
    if (full) {
      for (const [j, pr] of workspace.prs.entries()) {
        add('WorkspacePR', pr, 'observation', pr.observation, [
          'data',
          'workspaces',
          i,
          'prs',
          j,
          'observation',
        ]);
      }
    }
  }
  if (full) {
    for (const [i, session] of data.agentSessions.entries()) {
      add('AgentSession', session, 'providerMetadata', session.providerMetadata, [
        'data',
        'agentSessions',
        i,
        'providerMetadata',
      ]);
    }
  }
  const seen = new Set<string>();
  for (const [index, marker] of section.jsonStorage.entries()) {
    const key = JSON.stringify([marker.model, marker.identity[0], marker.field]);
    const values = targets.get(key);
    if (seen.has(key) || values?.length !== 1 || values[0] !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid ${marker.model} JSON-null target`,
        path: ['data', 'recovery', 'baseJson', 'jsonStorage', index, 'identity'],
      });
    }
    seen.add(key);
  }
}
