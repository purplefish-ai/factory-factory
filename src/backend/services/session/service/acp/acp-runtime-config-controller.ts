import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import { isNativeModeConfigOption } from './acp-config-option-identification';
import type { AcpProcessHandle } from './acp-process-handle';
import { requireSessionConfigOptions } from './acp-session-config-options';

const logger = createLogger('acp-runtime-manager');

export class AcpRuntimeConfigController {
  async setConfigOption(
    handle: AcpProcessHandle,
    configId: string,
    value: string,
    sessionId: string
  ): Promise<SessionConfigOption[]> {
    try {
      const response = await handle.connection.setSessionConfigOption({
        sessionId: handle.acpSessionId,
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
        sessionId,
        configId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionMode(
    handle: AcpProcessHandle,
    modeId: string,
    sessionId: string
  ): Promise<SessionConfigOption[]> {
    try {
      await handle.connection.setSessionMode({
        sessionId: handle.acpSessionId,
        modeId,
      });

      handle.configOptions = handle.configOptions.map((option) =>
        option.type === 'select' && isNativeModeConfigOption(option, 'mode')
          ? { ...option, currentValue: modeId }
          : option
      );

      return [...handle.configOptions];
    } catch (error) {
      logger.warn('setSessionMode failed', {
        sessionId,
        modeId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionModel(
    handle: AcpProcessHandle,
    modelId: string,
    sessionId: string
  ): Promise<SessionConfigOption[]> {
    const modelOption = handle.configOptions.find((option) => option.category === 'model');
    return await this.setConfigOption(handle, modelOption?.id ?? 'model', modelId, sessionId);
  }
}
