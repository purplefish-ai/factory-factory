# Stage 2: Extract Enums and Shared Types

**Risk**: Low-Medium
**Depends on**: Stage 1 (monorepo scaffolding)
**Estimated scope**: ~5 new files in core, ~50+ modified import sites in desktop

## Goal

Define all domain enums as framework-neutral TypeScript types in `@factory-factory/core` and migrate domain files to import from core instead of `@prisma-gen/client`. This breaks the single largest coupling between domain logic and the Prisma ORM.

## Problem

Every domain imports Prisma-generated enums directly:

```typescript
// Current: tightly coupled to Prisma
import type { WorkspaceStatus, CIStatus, RatchetState } from '@prisma-gen/client';
```

Core cannot depend on a Prisma schema that lives in the desktop app. We need framework-neutral enum definitions that both core and Prisma can agree on via structural typing.

## What Gets Done

### Part A: Define Enums in Core

Create `packages/core/src/types/enums.ts` with all domain enums as `const` objects + union types:

```typescript
// packages/core/src/types/enums.ts

export const WorkspaceStatus = {
  NEW: 'NEW',
  PROVISIONING: 'PROVISIONING',
  READY: 'READY',
  FAILED: 'FAILED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

export const SessionStatus = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const PRState = {
  NONE: 'NONE',
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED',
  MERGED: 'MERGED',
  CLOSED: 'CLOSED',
} as const;
export type PRState = (typeof PRState)[keyof typeof PRState];

export const CIStatus = {
  UNKNOWN: 'UNKNOWN',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;
export type CIStatus = (typeof CIStatus)[keyof typeof CIStatus];

export const KanbanColumn = {
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  DONE: 'DONE',
} as const;
export type KanbanColumn = (typeof KanbanColumn)[keyof typeof KanbanColumn];

export const RatchetState = {
  IDLE: 'IDLE',
  CI_RUNNING: 'CI_RUNNING',
  CI_FAILED: 'CI_FAILED',
  REVIEW_PENDING: 'REVIEW_PENDING',
  READY: 'READY',
  MERGED: 'MERGED',
} as const;
export type RatchetState = (typeof RatchetState)[keyof typeof RatchetState];

export const WorkspaceCreationSource = {
  MANUAL: 'MANUAL',
  RESUME_BRANCH: 'RESUME_BRANCH',
  GITHUB_ISSUE: 'GITHUB_ISSUE',
} as const;
export type WorkspaceCreationSource =
  (typeof WorkspaceCreationSource)[keyof typeof WorkspaceCreationSource];

export const RunScriptStatus = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type RunScriptStatus = (typeof RunScriptStatus)[keyof typeof RunScriptStatus];
```

**Why `const` objects instead of TypeScript `enum`?**: `const` objects produce the same string literal union types that Prisma generates, ensuring structural compatibility. They also tree-shake better and are idiomatic in modern TypeScript.

### Part B: Extract Pure Shared Functions

Move framework-neutral shared utilities into core:

| Source | Destination | Notes |
|--------|-------------|-------|
| `src/shared/ci-status.ts` | `packages/core/src/shared/ci-status.ts` | Pure function, depends only on `CIStatus` enum |
| `src/shared/workspace-sidebar-status.ts` | `packages/core/src/shared/workspace-sidebar-status.ts` | Pure derivation function |

Desktop's `src/shared/` files become re-exports from `@factory-factory/core`:

```typescript
// src/shared/ci-status.ts (after migration)
export { computeOverallCIStatus } from '@factory-factory/core';
```

### Part C: Migrate Domain Imports

Change domain files to import enums from `@factory-factory/core` instead of `@prisma-gen/client`.

**Before:**
```typescript
import type { CIStatus, RatchetState } from '@prisma-gen/client';
```

**After:**
```typescript
import type { CIStatus, RatchetState } from '@factory-factory/core';
```

For resource accessors and other Prisma-coupled code, they continue importing from `@prisma-gen/client` as needed for Prisma API calls. The types are structurally identical so they interoperate transparently.

## New Files

```
packages/core/src/
  types/
    enums.ts              # All domain enums
    index.ts              # Barrel re-export
  shared/
    ci-status.ts          # computeOverallCIStatus
    workspace-sidebar-status.ts  # deriveSidebarStatus
    index.ts              # Barrel re-export
  index.ts                # Updated: re-exports types/ and shared/
```

## Modified Files

### Domain files (import migration)

Files that import enums from `@prisma-gen/client` purely for type usage will be updated. Key locations:

- `src/backend/domains/ratchet/bridges.ts` (imports `CIStatus`)
- `src/backend/domains/ratchet/ratchet.service.ts`
- `src/backend/domains/ratchet/ci-fixer.service.ts`
- `src/backend/domains/ratchet/ci-monitor.service.ts`
- `src/backend/domains/workspace/state/flow-state.ts`
- `src/backend/domains/workspace/state/kanban-state.ts`
- `src/backend/domains/workspace/lifecycle/state-machine.service.ts`
- `src/backend/domains/session/claude/types.ts`
- `src/backend/domains/github/pr-snapshot.service.ts`
- And ~40 more files identified by grepping for `from '@prisma-gen/client'`

### Root `package.json`

Add `@factory-factory/core` as a workspace dependency:

```json
{
  "dependencies": {
    "@factory-factory/core": "workspace:*"
  }
}
```

### Root `tsconfig.json`

No changes needed -- the `@factory-factory/core` package resolution is handled by pnpm workspace, not TypeScript path aliases.

## Type Compatibility

Prisma generates enums as string literal unions:
```typescript
// Prisma-generated
type WorkspaceStatus = "NEW" | "PROVISIONING" | "READY" | "FAILED" | "ARCHIVED"
```

Core defines the same union via `const` objects:
```typescript
// Core-defined
type WorkspaceStatus = "NEW" | "PROVISIONING" | "READY" | "FAILED" | "ARCHIVED"
```

TypeScript's structural type system treats these as **identical** -- a `WorkspaceStatus` from core is assignable to a `WorkspaceStatus` from Prisma and vice versa. No runtime changes needed.

## Tests to Add

### `packages/core/src/types/enums.test.ts`

Validate enum definitions are complete and correct:

```typescript
describe('domain enums', () => {
  it('WorkspaceStatus has all expected values', () => {
    expect(Object.values(WorkspaceStatus)).toEqual([
      'NEW', 'PROVISIONING', 'READY', 'FAILED', 'ARCHIVED'
    ]);
  });
  // ... same for all 8 enums
});
```

### `packages/core/src/shared/ci-status.test.ts`

Port existing tests from `src/shared/ci-status.test.ts`.

### `packages/core/src/shared/workspace-sidebar-status.test.ts`

Port existing tests from `src/shared/workspace-sidebar-status.test.ts`.

## Migration Order

To minimize blast radius, migrate one domain at a time:

1. **Ratchet domain** (fewest files, cleanest boundaries)
2. **Workspace domain**
3. **Session domain**
4. **GitHub domain**
5. **Run-script and terminal domains**
6. **Shared utilities and orchestration layer**

Run `pnpm typecheck && pnpm test` after each domain migration.

## Verification Checklist

```bash
pnpm install
pnpm --filter @factory-factory/core build
pnpm --filter @factory-factory/core test
pnpm typecheck   # Proves structural type compatibility
pnpm test        # All existing tests still pass
pnpm check:fix   # Biome linting
```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Missed import site | Medium | `grep -r "from '@prisma-gen/client'" src/backend/domains/` to find all sites |
| Enum value mismatch | Low | Test in core validates exact values; typecheck catches mismatches |
| Runtime vs type-only imports | Low | Prisma enums used as values (not just types) need the `const` object import |
| Circular dependency core <-> root | Low | Core has no deps on root; root depends on core |

## Out of Scope

- Storage interfaces (Stage 3)
- Moving Claude protocol types (Stage 4)
- Moving domain service logic (Stage 5)
