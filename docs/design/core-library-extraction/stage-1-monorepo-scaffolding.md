# Stage 1: Monorepo Scaffolding

**Risk**: Very Low
**Depends on**: Nothing (first stage)
**Estimated scope**: ~8 new files, 0 modified source files

## Goal

Convert the single-package repo into a pnpm workspace monorepo and create the `packages/core/` skeleton. No existing code is moved or modified -- this is purely additive infrastructure.

## What Gets Done

1. Create `pnpm-workspace.yaml` at repo root
2. Create `packages/core/` with package.json, tsconfig, vitest config, and empty barrel file
3. Verify the root package still works alongside the new workspace member

## New Files

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
```

The root package remains an implicit workspace member (pnpm treats the root as a workspace member by default when `pnpm-workspace.yaml` exists).

### `packages/core/package.json`

```json
{
  "name": "@factory-factory/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

Notes:
- `"private": true` initially -- changed to `false` in Stage 6 when publishing
- `"type": "module"` matches the root package (ESM)
- Versions of typescript and vitest should match what root uses

### `packages/core/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Notes:
- No `@/*` path alias -- core uses relative imports only
- `noEmit: false` -- this config is used for building, not just type checking
- Strict settings match root tsconfig

### `packages/core/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
```

### `packages/core/src/index.ts`

```typescript
// @factory-factory/core
// Core library for Factory Factory workspace execution primitives.
// This module exports nothing yet -- content will be added in subsequent stages.
```

## Modified Files

### Root `package.json`

No structural changes required. The root package continues to work as-is. pnpm workspace resolution means `pnpm install` from root will install deps for all workspace members.

However, verify:
- `pnpm install` resolves correctly (may need `pnpm install` re-run)
- Root scripts (`pnpm dev`, `pnpm build`, `pnpm test`) are unaffected
- No accidental hoisting issues with shared deps

## Tests to Add

### `packages/core/src/index.test.ts`

A minimal smoke test that validates the package can be imported:

```typescript
import { describe, it, expect } from 'vitest';

describe('@factory-factory/core', () => {
  it('can be imported', async () => {
    const core = await import('./index');
    expect(core).toBeDefined();
  });
});
```

## Verification Checklist

```bash
# Workspace resolution works
pnpm install

# Core package builds
pnpm --filter @factory-factory/core build

# Core package tests pass
pnpm --filter @factory-factory/core test

# Core package type checks
pnpm --filter @factory-factory/core typecheck

# Root package still works (nothing changed)
pnpm typecheck
pnpm test
pnpm dev  # manual: verify app starts
```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| pnpm workspace hoisting conflicts | Low | Use `pnpm install` and check for resolution warnings |
| Root scripts break | Very Low | No root files are modified; workspace config is additive |
| CI pipeline confusion | Low | Ensure CI runs `pnpm install` from root first |

## Out of Scope

- Moving any existing source code
- Adding core as a dependency of the root package (done later)
- Modifying any import paths
- Biome configuration for core (use root config via inheritance)
