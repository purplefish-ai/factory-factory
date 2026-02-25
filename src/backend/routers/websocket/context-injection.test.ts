import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HANDLER_FILES = [
  'src/backend/routers/websocket/chat.handler.ts',
  'src/backend/routers/websocket/terminal.handler.ts',
  'src/backend/routers/websocket/dev-logs.handler.ts',
  'src/backend/routers/websocket/post-run-logs.handler.ts',
  'src/backend/routers/websocket/setup-terminal.handler.ts',
  'src/backend/routers/websocket/snapshots.handler.ts',
] as const;

describe('websocket handlers context injection', () => {
  for (const file of HANDLER_FILES) {
    it(`${file} does not create an AppContext at module scope`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');

      expect(source).not.toMatch(/=\s*create\w+UpgradeHandler\(createAppContext\(\)\);/);
    });
  }

  it('websocket barrel does not export context-owning upgrade handler instances', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/backend/routers/websocket/index.ts'),
      'utf8'
    );

    expect(source).not.toMatch(
      /handle(Chat|Terminal|DevLogs|PostRunLogs|SetupTerminal|Snapshots)Upgrade/
    );
  });
});
