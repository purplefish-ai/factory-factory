import type { ChatSessionSettings } from '@prisma-gen/client';
import { prisma } from '../db.js';

/**
 * Data for updating chat session settings.
 */
interface UpdateChatSessionSettingsData {
  selectedModel?: string | null;
  thinkingEnabled?: boolean;
  planModeEnabled?: boolean;
}

class ChatSessionSettingsAccessor {
  /**
   * Get settings for a session, creating default settings if they don't exist.
   * Uses upsert to avoid race conditions when multiple requests arrive simultaneously.
   */
  getOrCreate(sessionId: string): Promise<ChatSessionSettings> {
    return prisma.chatSessionSettings.upsert({
      where: { sessionId },
      create: {
        sessionId,
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
      update: {}, // No-op if exists
    });
  }

  /**
   * Get settings for a session without creating if they don't exist.
   */
  get(sessionId: string): Promise<ChatSessionSettings | null> {
    return prisma.chatSessionSettings.findUnique({
      where: { sessionId },
    });
  }

  /**
   * Update settings for a session.
   * Creates the settings record if it doesn't exist.
   */
  update(sessionId: string, data: UpdateChatSessionSettingsData): Promise<ChatSessionSettings> {
    return prisma.chatSessionSettings.upsert({
      where: { sessionId },
      create: {
        sessionId,
        selectedModel: data.selectedModel ?? null,
        thinkingEnabled: data.thinkingEnabled ?? false,
        planModeEnabled: data.planModeEnabled ?? false,
      },
      update: data,
    });
  }

  /**
   * Delete settings for a session.
   */
  async delete(sessionId: string): Promise<void> {
    await prisma.chatSessionSettings
      .delete({
        where: { sessionId },
      })
      .catch(() => {
        // Ignore if not found
      });
  }
}

export const chatSessionSettingsAccessor = new ChatSessionSettingsAccessor();
