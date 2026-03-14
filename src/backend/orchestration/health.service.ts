import { healthAccessor } from '@/backend/services/settings';

class HealthService {
  checkDatabaseConnection(): Promise<void> {
    return healthAccessor.checkDatabaseConnection();
  }
}

export const healthService = new HealthService();
