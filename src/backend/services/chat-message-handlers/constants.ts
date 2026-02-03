import { configService } from '../config.service';
import { createLogger } from '../logger.service';

export const logger = createLogger('chat-message-handlers');
export const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

export const VALID_MODELS = ['sonnet', 'opus'] as const;
export type ValidModel = (typeof VALID_MODELS)[number];

export function isValidModel(model: string | null | undefined): model is ValidModel {
  return !!model && VALID_MODELS.includes(model as ValidModel);
}
