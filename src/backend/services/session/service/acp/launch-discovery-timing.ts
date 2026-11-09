import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('session-launch-options');
/** Only provider identifiers belong here; never include credentials or subprocess output. */
export async function timeLaunchDiscovery<T>(
  stage: string,
  context: { provider: 'CLAUDE' | 'CODEX'; model?: string; codexAccountId?: string },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    logger.info('Launch discovery stage completed', {
      ...context,
      stage,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.warn('Launch discovery stage failed', {
      ...context,
      stage,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
