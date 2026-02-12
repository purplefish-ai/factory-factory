import { configService } from '@/backend/services/config.service';
export const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

export function normalizeRequestedModel(model: string | null | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const normalized = model.trim();
  return normalized.length > 0 ? normalized : undefined;
}
