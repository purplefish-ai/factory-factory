import { configService } from '@/backend/services/config.service';
export const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

export function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
