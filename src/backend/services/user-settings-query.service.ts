import type { UserSettings } from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';

class UserSettingsQueryService {
  get(): Promise<UserSettings> {
    return userSettingsAccessor.get();
  }

  update(data: {
    preferredIde?: string;
    customIdeCommand?: string | null;
    playSoundOnComplete?: boolean;
    notificationSoundPath?: string | null;
    ratchetEnabled?: boolean;
  }): Promise<UserSettings> {
    return userSettingsAccessor.update(data);
  }

  getWorkspaceOrder(projectId: string): Promise<string[]> {
    return userSettingsAccessor.getWorkspaceOrder(projectId);
  }

  updateWorkspaceOrder(projectId: string, workspaceIds: string[]): Promise<UserSettings> {
    return userSettingsAccessor.updateWorkspaceOrder(projectId, workspaceIds);
  }
}

export const userSettingsQueryService = new UserSettingsQueryService();
