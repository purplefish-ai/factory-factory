import { describe, expect, it } from 'vitest';
import { settingsHealthService, userSettingsService } from '@/backend/services/settings';

describe('settings domain exports', () => {
  it('exports capsule-owned settings services', () => {
    expect(userSettingsService).toBeDefined();
    expect(settingsHealthService).toBeDefined();
  });
});
