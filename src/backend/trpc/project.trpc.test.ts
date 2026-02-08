import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactoryConfigService } from '../services/factory-config.service';

describe('FactoryConfigService', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join('/tmp', `factory-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('readConfig', () => {
    it('should return null when factory-factory.json does not exist', async () => {
      const config = await FactoryConfigService.readConfig(testDir);
      expect(config).toBeNull();
    });

    it('should parse valid factory-factory.json', async () => {
      const configContent = {
        scripts: {
          setup: 'npm install',
          run: 'npm start',
          cleanup: 'npm run clean',
        },
      };

      await writeFile(join(testDir, 'factory-factory.json'), JSON.stringify(configContent));

      const config = await FactoryConfigService.readConfig(testDir);
      expect(config).toEqual(configContent);
    });

    it('should parse factory-factory.json with only some scripts', async () => {
      const configContent = {
        scripts: {
          run: 'npm start',
        },
      };

      await writeFile(join(testDir, 'factory-factory.json'), JSON.stringify(configContent));

      const config = await FactoryConfigService.readConfig(testDir);
      expect(config).toEqual(configContent);
    });

    it('should throw error on invalid JSON', async () => {
      await writeFile(join(testDir, 'factory-factory.json'), 'invalid json {');

      await expect(FactoryConfigService.readConfig(testDir)).rejects.toThrow(/Invalid JSON/);
    });

    it('should throw error on invalid schema', async () => {
      const invalidConfig = {
        scripts: 'not an object',
      };

      await writeFile(join(testDir, 'factory-factory.json'), JSON.stringify(invalidConfig));

      await expect(FactoryConfigService.readConfig(testDir)).rejects.toThrow(/Invalid schema/);
    });
  });

  describe('checkFactoryConfig endpoint behavior', () => {
    it('should return exists: false when no config file', async () => {
      const config = await FactoryConfigService.readConfig(testDir);
      const result = { exists: config !== null };

      expect(result).toEqual({ exists: false });
    });

    it('should return exists: true when valid config', async () => {
      const configContent = {
        scripts: {
          run: 'npm start',
        },
      };

      await writeFile(join(testDir, 'factory-factory.json'), JSON.stringify(configContent));

      const config = await FactoryConfigService.readConfig(testDir);
      const result = { exists: config !== null };

      expect(result).toEqual({ exists: true });
    });
  });
});
