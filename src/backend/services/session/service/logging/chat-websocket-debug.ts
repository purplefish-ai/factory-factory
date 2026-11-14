import { configService } from '@/backend/services/config.service';
export const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;
