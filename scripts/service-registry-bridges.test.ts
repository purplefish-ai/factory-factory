import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { collectBridgeEdges } from './service-registry-bridges';

const fixtureFiles: Record<string, string> = {
  'src/backend/services/alpha/index.ts':
    "export { alphaService } from './service/alpha.service';\n",
  'src/backend/services/alpha/service/alpha.service.ts': `
export type AlphaBridges = {
  beta: { ping(): number };
  gamma: () => string;
  idle: () => void;
  orchestrated: () => void;
};
class AlphaService {
  configure(_bridges: AlphaBridges): void {}
  configureSelf(_bridge: { self: () => void }): void {}
  register(_bridge: { beta: () => number }): void {}
  ownHelper(): void {}
}
export const alphaService = new AlphaService();
`,
  'src/backend/services/beta/index.ts': `
class BetaService {
  ping(): number { return 1; }
  pong(): number { return 2; }
}
export const betaService = new BetaService();
`,
  'src/backend/services/gamma/index.ts': "export function gammaHelper(): string { return 'g'; }\n",
  'src/backend/services/delta/index.ts': `
class DeltaService {
  setHandler(_handler: () => void): void {}
  touch(): void {}
}
export const deltaService = new DeltaService();
`,
  'src/backend/services/logger.service.ts': 'export function createLogger(): void {}\n',
  'src/backend/orchestration/helper.orchestrator.ts': 'export function orchestrate(): void {}\n',
  'src/backend/orchestration/bridges.orchestrator.ts': `
import { alphaService } from '@/backend/services/alpha';
import type { betaService } from '@/backend/services/beta';
import { deltaService } from '@/backend/services/delta';
import { gammaHelper } from '@/backend/services/gamma';
import { createLogger } from '@/backend/services/logger.service';
import { orchestrate } from './helper.orchestrator';

export function wire(services: { beta: Pick<typeof betaService, 'ping' | 'pong'> }): void {
  const { beta } = services;
  const viaLocal = () => gammaHelper();
  const touchDelta = () => deltaService.touch();
  alphaService.configure({
    beta: { ping: () => beta.ping() },
    gamma: viaLocal,
    idle: touchDelta,
    orchestrated: () => { createLogger(); orchestrate(); },
  });
  alphaService.configureSelf({ self: () => alphaService.ownHelper() });
  alphaService.register({ beta: () => beta.pong() });
}
`,
  'src/backend/orchestration/handler.orchestrator.ts': `
import { betaService } from '@/backend/services/beta';
import { deltaService } from '@/backend/services/delta';

export function wireHandler(): void {
  const markIdle = () => betaService.ping();
  deltaService.setHandler(() => { void ({ markIdle }); });
}
`,
};

let repositoryRoot: string;

beforeAll(() => {
  repositoryRoot = mkdtempSync(path.join(tmpdir(), 'ff-service-bridges-'));
  for (const [relativePath, content] of Object.entries(fixtureFiles)) {
    const filePath = path.join(repositoryRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
});

afterAll(() => rmSync(repositoryRoot, { recursive: true, force: true }));

function scan(wiringFiles: string[]) {
  return collectBridgeEdges({
    repositoryRoot,
    wiringFiles: wiringFiles.map((file) => path.join(repositoryRoot, file)),
    serviceNames: new Set(['alpha', 'beta', 'gamma', 'delta']),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
      paths: { '@/*': [path.join(repositoryRoot, 'src/*')] },
    },
  });
}

describe('collectBridgeEdges', () => {
  test('attributes capabilities passed to configure() to the capsule that declares them', () => {
    const edges = scan(['src/backend/orchestration/bridges.orchestrator.ts']);

    expect(edges.map(({ from, to }) => `${from} -> ${to}`)).toEqual([
      // `beta.ping()` reached through `Pick<typeof betaService, ...>`.
      'alpha -> beta',
      // `idle: touchDelta`, a local helper in the wiring file.
      'alpha -> delta',
      // `gamma: viaLocal`, a local helper in the wiring file.
      'alpha -> gamma',
    ]);
    expect(edges[0]?.site).toMatch(/^src\/backend\/orchestration\/bridges\.orchestrator\.ts:\d+$/);
  });

  test('ignores orchestration callbacks, infrastructure, self-references and other methods', () => {
    const edges = scan(['src/backend/orchestration/bridges.orchestrator.ts']);

    // `register()` is not a wiring method, so its `beta.pong()` is not an edge;
    // `createLogger` is root infrastructure and `orchestrate` is orchestration.
    expect(edges.filter((edge) => edge.to === 'alpha')).toEqual([]);
    expect(edges).toHaveLength(3);
  });

  test('follows shorthand properties into local helpers and recognises setHandler()', () => {
    const edges = scan(['src/backend/orchestration/handler.orchestrator.ts']);

    expect(edges.map(({ from, to }) => `${from} -> ${to}`)).toEqual(['delta -> beta']);
  });
});
