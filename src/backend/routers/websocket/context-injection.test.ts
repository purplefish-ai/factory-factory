import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRANSPORT_FILES = [
  'src/backend/server.ts',
  'src/backend/routers/health.router.ts',
  'src/backend/routers/websocket/chat-connection-registry.ts',
  'src/backend/routers/websocket/chat.handler.ts',
  'src/backend/routers/websocket/terminal.handler.ts',
  'src/backend/routers/websocket/dev-logs.handler.ts',
  'src/backend/routers/websocket/post-run-logs.handler.ts',
  'src/backend/routers/websocket/setup-terminal.handler.ts',
  'src/backend/routers/websocket/snapshots.handler.ts',
] as const;

const FORBIDDEN_RUNTIME_BINDINGS = [
  'configureDomainBridges',
  'configService',
  'createLogger',
  'eventCollectorOrchestrator',
  'healthService',
  'prisma',
  'registerInterceptors',
  'sessionEventBus',
  'sessionFileLogger',
  'snapshotReconciliationService',
  'startInterceptors',
  'stopInterceptors',
  'sessionDataService',
  'workspaceDataService',
  'workspaceQueryService',
  'workspaceSnapshotStore',
] as const;

describe('HTTP and WebSocket application context injection', () => {
  for (const file of TRANSPORT_FILES) {
    it(`${file} does not create an AppContext at module scope`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');

      expect(source).not.toMatch(/=\s*create\w+UpgradeHandler\(createAppContext\(\)\);/);
    });
  }

  it('server lifecycle never performs composition-time dependency wiring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/backend/server.ts'), 'utf8');

    expect(source).not.toMatch(/\.configure\s*\(/);
    expect(source).not.toMatch(/\bconfigureDomainBridges\b/);
    expect(source).not.toMatch(/\bcreateApplication\s*\(/);
  });

  for (const file of TRANSPORT_FILES) {
    it(`${file} resolves long-lived dependencies through the application graph`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const valueImports = source.matchAll(
        /import\s+(?!type\b)([\s\S]*?)\s+from\s+['"](@\/backend\/(?:services|orchestration|db)(?:\/[^'"]*)?)['"]/g
      );

      for (const [, bindings] of valueImports) {
        expect(bindings).not.toMatch(
          new RegExp(`\\b(?:${FORBIDDEN_RUNTIME_BINDINGS.join('|')})\\b`)
        );
      }
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
