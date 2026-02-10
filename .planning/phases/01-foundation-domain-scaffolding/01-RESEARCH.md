# Phase 1: Foundation & Domain Scaffolding - Research

**Researched:** 2026-02-10
**Domain:** TypeScript project structure, barrel file conventions, dependency-cruiser rule configuration
**Confidence:** HIGH

## Summary

Phase 1 is a scaffolding phase that creates directory structure, barrel files, and dependency-cruiser rules. No business logic moves in this phase -- that happens in Phases 2-7. The key challenge is establishing conventions that the subsequent 6 domain consolidation phases will follow, and configuring dependency-cruiser to enforce domain boundaries from day one.

The existing codebase provides a strong reference point: `src/backend/domains/session/` already exists with `session-domain.service.ts` and its test file. The project already has dependency-cruiser v17.3.7 installed and configured with 12 rules, all currently passing (647 modules, 2365 dependencies). The barrel file pattern is already established in `src/backend/resource_accessors/index.ts` and `src/backend/services/index.ts`.

**Primary recommendation:** Create 5 new domain directories (workspace, github, ratchet, terminal, run-script) with minimal barrel files that re-export nothing yet, add a single dependency-cruiser rule using group matching (`$1` capture) to enforce no cross-domain imports, and add an `index.ts` barrel file to the existing session domain directory.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, barrel files, path aliases | Already configured in project |
| dependency-cruiser | 17.3.7 | Import rule enforcement | Already installed as devDependency, 12 rules configured |
| Biome | 2.3.13 | Formatting and linting | Already configured, will auto-format new files |
| Vitest | 4.0.18 | Test runner | Already configured, tests co-located with source |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pnpm | 10.28.1 | Package manager | All npm operations |

### Alternatives Considered

None -- this phase uses exclusively existing tooling. No new dependencies required.

**Installation:**
```bash
# No new packages needed. All tools already in place.
```

## Architecture Patterns

### Recommended Domain Directory Structure

Each domain directory under `src/backend/domains/{name}/` follows this pattern:

```
src/backend/domains/
├── session/                         # Already exists (extend with index.ts)
│   ├── index.ts                     # NEW: barrel file
│   ├── session-domain.service.ts    # Existing
│   └── session-domain.service.test.ts # Existing
├── workspace/                       # NEW
│   └── index.ts                     # Barrel file (empty re-exports for now)
├── github/                          # NEW
│   └── index.ts
├── ratchet/                         # NEW
│   └── index.ts
├── terminal/                        # NEW
│   └── index.ts
└── run-script/                      # NEW
    └── index.ts
```

### Pattern 1: Barrel File Convention

**What:** Each domain exports its public API through a single `index.ts` file. Consumers import from `@/backend/domains/{name}` (not from internal files).

**When to use:** Always, for every domain module.

**Existing pattern in codebase (resource_accessors/index.ts):**
```typescript
// Source: src/backend/resource_accessors/index.ts
export * from './claude-session.accessor';
export * from './data-backup.accessor';
export * from './workspace.accessor';
// ...etc
```

**Domain barrel file pattern for Phase 1 (placeholder):**
```typescript
// src/backend/domains/workspace/index.ts
// Domain: workspace
// Public API will be populated during Phase 3 (Workspace Domain Consolidation)
```

**Session domain barrel file (has existing exports):**
```typescript
// src/backend/domains/session/index.ts
export { sessionDomainService } from './session-domain.service';
```

### Pattern 2: Service Singleton Export

**What:** Domain services are classes instantiated once and exported as const singletons.

**When to use:** For all domain services (this is the established project convention).

**Existing pattern:**
```typescript
// Source: src/backend/domains/session/session-domain.service.ts
class SessionDomainService {
  // ...methods
}

export const sessionDomainService = new SessionDomainService();
```

### Pattern 3: Dependency-Cruiser Cross-Domain Rule with Group Matching

**What:** A single rule that prevents any domain from importing from any other domain, using regex group capture (`$1`) so the rule scales automatically as domains are added.

**When to use:** Immediately in Phase 1, before any code moves. This makes violations visible from the start.

**Example rule:**
```javascript
// Source: dependency-cruiser rules-reference.md (group matching)
{
  name: "no-cross-domain-imports",
  severity: "error",
  comment:
    "Domain modules must not import from sibling domains. " +
    "Use the orchestration layer for cross-domain coordination.",
  from: { path: "^src/backend/domains/([^/]+)/" },
  to: {
    path: "^src/backend/domains/([^/]+)/",
    pathNot: "^src/backend/domains/$1/",
  },
},
```

This captures the domain name in `$1` from the `from.path`, then the `to.pathNot` excludes imports within the same domain. Only cross-domain imports are flagged.

### Anti-Patterns to Avoid

- **Premature code movement:** Phase 1 must NOT move any service files. Only scaffolding and rules. Moving code is Phases 2-7.
- **Deep barrel re-exports in Phase 1:** New domain barrel files should be empty or minimal. Do not re-export services that have not been moved yet.
- **Overly specific dependency-cruiser rules:** One group-matching rule handles all domain boundaries. Avoid writing separate rules per domain pair (N^2 explosion).
- **Breaking existing session imports:** The session domain already has consumers importing from `@/backend/domains/session/session-domain.service.ts`. The new barrel file should not break these -- the barrel file is additive.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import boundary enforcement | Manual code review | dependency-cruiser rules | Already in CI, catches violations automatically |
| File formatting | Manual formatting | `pnpm check:fix` (Biome) | Ensures new files match project style |
| Path resolution | Hardcoded relative paths | `@/*` path alias | Already configured in tsconfig.json |

**Key insight:** This phase is pure scaffolding. All tooling already exists. The value is in establishing the right conventions and guard rails before the heavy lifting in Phases 2-7.

## Common Pitfalls

### Pitfall 1: Barrel File Circular Dependencies

**What goes wrong:** Creating barrel files that re-export from modules that import back into the barrel creates circular dependency chains.
**Why it happens:** When two modules in the same domain import from each other, and both are re-exported from index.ts.
**How to avoid:** In Phase 1, keep barrel files minimal (empty or single export for session). Circular dependency issues surface during Phases 2-7 when code actually moves.
**Warning signs:** dependency-cruiser's existing `no-circular` rule will catch this.

### Pitfall 2: Forgetting Test File Exclusions in Rules

**What goes wrong:** Dependency-cruiser rules block test files from importing across domains, but tests legitimately need cross-domain imports for integration testing.
**Why it happens:** Test files follow the same path pattern as source files.
**How to avoid:** Add `pathNot` exclusion for test files in the cross-domain rule if needed. The existing codebase already uses this pattern (see `only-session-domain-imports-session-store` rule which excludes `.test.ts`).
**Warning signs:** Test files failing dependency-cruiser checks after rule addition.

### Pitfall 3: Session Domain Barrel Breaking Existing Imports

**What goes wrong:** Adding `index.ts` to session domain could change module resolution for existing direct imports.
**Why it happens:** TypeScript resolves `@/backend/domains/session` to `index.ts` when it exists, which could conflict if consumers import `@/backend/domains/session/session-domain.service`.
**How to avoid:** Existing imports use the full path (`@/backend/domains/session/session-domain.service`), not the directory path. The barrel file at `index.ts` adds a new import path but does not break existing ones. Both coexist.
**Warning signs:** `pnpm typecheck` failures after adding the barrel file.

### Pitfall 4: Empty Directories Ignored by Git

**What goes wrong:** New domain directories with only an empty `index.ts` might be missed if the file has no content.
**Why it happens:** Git tracks files, not directories. An empty file is still tracked, but developers might skip creating it.
**How to avoid:** Every barrel file should have at least a comment header identifying the domain and its purpose.
**Warning signs:** Missing directories after checkout.

## Code Examples

Verified patterns from the existing codebase:

### Existing Barrel File (resource_accessors)

```typescript
// Source: src/backend/resource_accessors/index.ts
export * from './claude-session.accessor';
export * from './data-backup.accessor';
export * from './decision-log.accessor';
export * from './health.accessor';
export * from './project.accessor';
export * from './terminal-session.accessor';
export * from './user-settings.accessor';
export * from './workspace.accessor';
```

### Existing Dependency-Cruiser Rule (pattern to follow)

```javascript
// Source: .dependency-cruiser.cjs (only-session-domain-imports-session-store)
{
  name: "only-session-domain-imports-session-store",
  severity: "error",
  comment:
    "Session transcript/store internals are single-writer infrastructure " +
    "and may only be imported by the session domain layer",
  from: {
    path: "^src/backend",
    pathNot:
      "^src/backend/domains/session/|^src/backend/services/session-store\\.service\\.ts$|^src/backend/.*\\.test\\.ts$",
  },
  to: { path: "^src/backend/services/session-store\\.service\\.ts$" },
},
```

### New Cross-Domain Rule (verified syntax against dependency-cruiser v17 docs)

```javascript
// For .dependency-cruiser.cjs
{
  name: "no-cross-domain-imports",
  severity: "error",
  comment:
    "Domain modules must not import from sibling domains directly. " +
    "Cross-domain coordination goes through the orchestration layer (Phase 8).",
  from: { path: "^src/backend/domains/([^/]+)/" },
  to: {
    path: "^src/backend/domains/([^/]+)/",
    pathNot: "^src/backend/domains/$1/",
  },
},
```

### New Domain Barrel File Template

```typescript
// src/backend/domains/{name}/index.ts
//
// Domain: {name}
// Public API for the {name} domain module.
// Consumers should import from '@/backend/domains/{name}' only.
//
// This barrel file will be populated during Phase N
// ({Name} Domain Consolidation).
```

### Session Domain Barrel File

```typescript
// src/backend/domains/session/index.ts
//
// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/domains/session' only.
//
export { sessionDomainService } from './session-domain.service';
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat services directory (45+ files) | Domain modules under `domains/` | Emerging now (session domain exists) | Phases 2-7 consolidate services into domains |
| No import boundary enforcement between domains | dependency-cruiser group matching rule | Phase 1 adds this | Prevents regression during and after refactor |

**Current state:**
- dependency-cruiser v17.3.7 is current (latest is 17.x series)
- 12 rules already configured and passing
- 647 modules, 2365 dependencies in the graph
- `pnpm deps:check` passes cleanly

## Open Questions

1. **Should the cross-domain rule exclude test files?**
   - What we know: The existing `only-session-domain-imports-session-store` rule excludes `.test.ts` files. Integration tests in Phase 10 may need cross-domain imports.
   - What's unclear: Whether any tests in Phases 2-7 will need cross-domain access.
   - Recommendation: Start strict (no exclusion). If tests need cross-domain imports, add `pathNot: ".*\\.test\\.ts$"` to the `from` clause later. This follows the "start strict, relax if needed" principle.

2. **Should existing direct imports of `session-domain.service.ts` be updated to use the barrel file?**
   - What we know: 15 files currently import from `@/backend/domains/session/session-domain.service`. The barrel would allow `@/backend/domains/session`.
   - What's unclear: Whether Phase 1 should update these or leave for Phase 2/9.
   - Recommendation: Leave existing imports as-is in Phase 1. Phase 9 (Import Rewiring) handles this. Avoids unnecessary churn.

## Sources

### Primary (HIGH confidence)
- Existing codebase files: `.dependency-cruiser.cjs`, `src/backend/domains/session/`, `src/backend/services/index.ts`, `src/backend/resource_accessors/index.ts`
- `package.json` devDependencies: dependency-cruiser v17.3.7
- `tsconfig.json`: path aliases `@/*` -> `./src/*`
- Live verification: `pnpm deps:check` passes with 647 modules, 2365 dependencies

### Secondary (MEDIUM confidence)
- [dependency-cruiser rules-reference.md](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) - Group matching with `$1` capture in `pathNot`

### Tertiary (LOW confidence)
- None. All findings verified against codebase or official docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all tools already installed and configured in the project
- Architecture: HIGH - pattern directly observed in existing `src/backend/domains/session/`
- Dependency-cruiser rules: HIGH - existing 12 rules verified passing, group matching syntax verified against official docs
- Pitfalls: HIGH - derived from actual codebase patterns and existing rule precedents

**Research date:** 2026-02-10
**Valid until:** 2026-04-10 (stable tooling, no fast-moving dependencies)
