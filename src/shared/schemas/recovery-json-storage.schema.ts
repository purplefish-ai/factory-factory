import { z } from 'zod';

export const baseJsonSectionSchema = z.strictObject({
  version: z.literal(1),
  jsonStorage: z.array(
    z.strictObject({
      model: z.literal('Workspace'),
      identity: z.tuple([z.string()]),
      field: z.literal('creationMetadata'),
    })
  ),
});
export type BaseJsonSection = z.infer<typeof baseJsonSectionSchema>;
export function validateBaseJsonTargets(
  workspaces: { id: string; creationMetadata?: unknown }[],
  section: BaseJsonSection,
  ctx: z.RefinementCtx
): void {
  const targets = new Map<string, typeof workspaces>();
  for (const workspace of workspaces) {
    const rows = targets.get(workspace.id) ?? [];
    rows.push(workspace);
    targets.set(workspace.id, rows);
    if (!Object.hasOwn(workspace, 'creationMetadata') || workspace.creationMetadata === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Covered creationMetadata must be present' });
    }
  }
  const seen = new Set<string>();
  for (const marker of section.jsonStorage) {
    const id = marker.identity[0];
    const rows = targets.get(id);
    if (seen.has(id) || rows?.length !== 1 || rows[0]?.creationMetadata !== null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid Workspace JSON-null target' });
    }
    seen.add(id);
  }
}
