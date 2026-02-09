import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type FactoryConfig, FactoryConfigSchema } from '@/shared/schemas/factory-config.schema';

/**
 * Schema for factory-factory.json configuration file
 */
/**
 * Service for reading and parsing factory-factory.json configuration
 */
export class FactoryConfigService {
  private static readonly CONFIG_FILENAME = 'factory-factory.json';

  /**
   * Read and parse factory-factory.json from a repository path
   * @param repoPath - Absolute path to the repository root
   * @returns Parsed config or null if file doesn't exist
   * @throws Error if file exists but is invalid JSON or doesn't match schema
   */
  static async readConfig(repoPath: string): Promise<FactoryConfig | null> {
    const configPath = join(repoPath, FactoryConfigService.CONFIG_FILENAME);

    // Check if file exists
    try {
      await access(configPath);
    } catch {
      // File doesn't exist - this is OK
      return null;
    }

    // Read and parse file
    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = FactoryConfigSchema.parse(parsed);
      return validated;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid JSON in ${FactoryConfigService.CONFIG_FILENAME}: ${error.message}`
        );
      }
      if (error instanceof z.ZodError) {
        const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new Error(`Invalid schema in ${FactoryConfigService.CONFIG_FILENAME}: ${issues}`);
      }
      throw error;
    }
  }

  /**
   * Replace {port} placeholder in script with actual port number
   */
  static substitutePort(script: string, port: number): string {
    return script.replace(/\{port\}/g, port.toString());
  }
}
