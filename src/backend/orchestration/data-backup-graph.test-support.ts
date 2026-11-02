import { vi } from 'vitest';
import type { Prisma } from '@prisma-gen/client';

/** Keep legacy collision fixtures while exposing the new bounded graph-read port. */
export function recoveryWorkspaceRead(
  findUnique: (args: { where: { id: string } }) => Promise<unknown>,
  exportRead: (args: Prisma.WorkspaceFindManyArgs) => Promise<unknown>
) {
  return vi.fn((args: Prisma.WorkspaceFindManyArgs) => {
    const filter = args.where?.id;
    const ids = typeof filter === 'object' && filter && Array.isArray(filter.in) ? filter.in : [];
    return args.where
      ? Promise.all(ids.map((id: string) => findUnique({ where: { id } }))).then((rows) =>
          rows.filter((row) => row !== null)
        )
      : exportRead(args);
  });
}
