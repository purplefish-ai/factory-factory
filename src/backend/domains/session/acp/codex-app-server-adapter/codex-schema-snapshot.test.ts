import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const SNAPSHOT_PATH = resolve(
  'src/backend/domains/session/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json'
);

const REQUIRED_APP_SERVER_METHODS = [
  'initialize',
  'initialized',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/interrupt',
  'model/list',
  'configRequirements/read',
  'config/value/write',
  'config/mcpServer/reload',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
] as const;

const snapshotSchema = z.object({
  allMethods: z.array(z.string()),
});

describe('codex schema snapshot contract', () => {
  it('contains methods used by the ACP adapter', () => {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    const snapshot = snapshotSchema.parse(parsed);
    const allMethods = new Set(snapshot.allMethods);

    for (const method of REQUIRED_APP_SERVER_METHODS) {
      expect(allMethods.has(method)).toBe(true);
    }
  });
});
