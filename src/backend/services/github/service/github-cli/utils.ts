import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('github-cli');

/**
 * Parse and validate gh CLI JSON output using a Zod schema.
 * Logs and throws on validation failure.
 */
export function parseGhJson<T>(schema: z.ZodSchema<T>, stdout: string, context: string): T {
  try {
    const data = JSON.parse(stdout);
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Invalid gh CLI JSON response', {
        context,
        validationErrors: error.issues,
        stdout: stdout.slice(0, 500),
      });
      throw new Error(`Invalid gh CLI response for ${context}: ${error.message}`);
    }
    logger.error('Failed to parse gh CLI JSON', {
      context,
      error: error instanceof Error ? error.message : String(error),
      stdout: stdout.slice(0, 500),
    });
    throw new Error(`Failed to parse gh CLI JSON for ${context}`);
  }
}
