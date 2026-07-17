import { healthAccessor } from '@/backend/services/settings/resources/health.accessor';

class SettingsHealthService {
  checkDatabaseConnection(): Promise<void> {
    return healthAccessor.checkDatabaseConnection();
  }
}

export const settingsHealthService = new SettingsHealthService();
