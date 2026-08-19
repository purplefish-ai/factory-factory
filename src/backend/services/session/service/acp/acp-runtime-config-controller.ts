import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle } from './acp-process-handle';
import { isMethodNotFoundError } from './acp-runtime-errors';
import { requireSessionConfigOptions } from './acp-session-config-options';

const logger = createLogger('acp-runtime-config-controller');

export class AcpRuntimeConfigController {
  async setConfigOption(
    handle: AcpProcessHandle,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    try {
      const response = await handle.connection.setSessionConfigOption({
        sessionId: handle.providerSessionId,
        configId,
        value,
      });

      const configOptions = requireSessionConfigOptions(handle.provider, 'setSessionConfigOption', {
        configOptions: response.configOptions,
      });
      handle.configOptions = configOptions;
      return configOptions;
    } catch (error) {
      logger.warn('setSessionConfigOption failed', {
        sessionId: handle.providerSessionId,
        configId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionMode(handle: AcpProcessHandle, modeId: string): Promise<SessionConfigOption[]> {
    try {
      await handle.connection.setSessionMode({
        sessionId: handle.providerSessionId,
        modeId,
      });

      handle.configOptions = handle.configOptions.map((option) =>
        option.category === 'mode' ? { ...option, currentValue: modeId } : option
      );

      return [...handle.configOptions];
    } catch (error) {
      logger.warn('setSessionMode failed', {
        sessionId: handle.providerSessionId,
        modeId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionModel(handle: AcpProcessHandle, modelId: string): Promise<SessionConfigOption[]> {
    const applyModelToCache = (): SessionConfigOption[] => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.category === 'model' ? { ...option, currentValue: modelId } : option
      );
      return [...handle.configOptions];
    };

    if (handle.provider === 'CLAUDE') {
      try {
        await handle.connection.unstable_setSessionModel({
          sessionId: handle.providerSessionId,
          modelId,
        });
        return applyModelToCache();
      } catch (error) {
        if (!isMethodNotFoundError(error)) {
          logger.warn('setSessionModel failed', {
            sessionId: handle.providerSessionId,
            modelId,
            provider: handle.provider,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        logger.warn(
          'unstable_setSessionModel unavailable, falling back to setSessionConfigOption',
          {
            sessionId: handle.providerSessionId,
            modelId,
            provider: handle.provider,
          }
        );
      }
    }

    return await this.setConfigOption(handle, 'model', modelId);
  }
}
