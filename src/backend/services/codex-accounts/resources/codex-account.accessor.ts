import { prisma } from '@/backend/db';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';

export const codexAccountAccessor = {
  async list() {
    await prisma.codexAccount.upsert({
      where: { id: NATIVE_DEFAULT_CODEX_ACCOUNT_ID },
      update: {},
      create: {
        id: NATIVE_DEFAULT_CODEX_ACCOUNT_ID,
        label: 'Native default',
        kind: 'NATIVE_DEFAULT',
      },
    });
    return prisma.codexAccount.findMany({ orderBy: { createdAt: 'asc' } });
  },
  get(id: string) {
    return prisma.codexAccount.findUnique({ where: { id } });
  },
  create(label: string) {
    return prisma.codexAccount.create({ data: { label, kind: 'MANAGED' } });
  },
  update(id: string, data: { label?: string; enabled?: boolean; identityKey?: string }) {
    return prisma.codexAccount.update({ where: { id }, data });
  },
};
