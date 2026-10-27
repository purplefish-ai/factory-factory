import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const repositoryRoot = process.cwd();

function checkBoundary(producer: string, ports = 'export interface Ports {}') {
  const root = mkdtempSync(join(tmpdir(), 'pr-observation-boundary-'));
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext' } }),
    'src/backend/orchestration/pr-observation.orchestrator.ts': producer,
    'src/backend/orchestration/pr-observation-ports.ts': ports,
    'src/backend/orchestration/pr-delivery-dependencies.ts': 'export const service = true;',
    'src/backend/services/github/index.ts':
      'export const service = true; export interface Contract {}',
    'src/backend/services/session/index.ts': 'export const service = true;',
    'src/backend/services/ratchet/index.ts': 'export const service = true;',
    'src/shared/observation.ts': 'export interface Observation {}',
  };
  try {
    for (const [path, source] of Object.entries(files)) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    return spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        'src',
        '--config',
        resolve(repositoryRoot, '.dependency-cruiser.cjs'),
      ],
      { cwd: root, encoding: 'utf8' }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('allows observation to depend on its narrow ports and shared contracts', () => {
  const result = checkBoundary(
    "import type { Ports } from './pr-observation-ports'; export type Input = Ports;",
    "import type { Observation } from '../../shared/observation'; export type Ports = Observation;"
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it.each([
  '../services/github',
  '../services/session',
  '../services/ratchet',
  './pr-delivery-dependencies',
])('rejects producer runtime imports from %s', (dependency) => {
  const result = checkBoundary(
    `import { service } from '${dependency}'; export const value = service;`
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('pr-observation-producer-has-no-runtime-backend-dependencies');
});

it('rejects broad service contracts in observation ports even for type-only imports', () => {
  const result = checkBoundary(
    "import type { Ports } from './pr-observation-ports'; export type Input = Ports;",
    "import type { Contract } from '../services/github'; export type Ports = Contract;"
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('pr-observation-ports-are-application-independent');
});
