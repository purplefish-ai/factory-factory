import { healthAccessor } from '@/backend/resource_accessors/health.accessor';

class HealthService {
  checkDatabaseConnection(): Promise<void> {
    return healthAccessor.checkDatabaseConnection();
  }
}

export const healthService = new HealthService();
