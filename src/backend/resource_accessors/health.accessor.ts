import { prisma } from '../db';

class HealthAccessor {
  async checkDatabaseConnection(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  }
}

export const healthAccessor = new HealthAccessor();
