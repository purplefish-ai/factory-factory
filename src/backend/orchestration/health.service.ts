import { settingsHealthService } from '@/backend/services/settings';

class HealthService {
  checkDatabaseConnection(): Promise<void> {
    return settingsHealthService.checkDatabaseConnection();
  }
}

export const healthService = new HealthService();
