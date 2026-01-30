# Coding Conventions

**Analysis Date:** 2026-01-29

## Naming Patterns

**Files:**
- Backend services: `{name}.service.ts` (e.g., `logger.service.ts`, `scheduler.service.ts`)
- Backend resource accessors: `{name}.accessor.ts` (e.g., `workspace.accessor.ts`)
- Backend tRPC routers: `{name}.trpc.ts` (e.g., `project.router.ts`, `workspace.trpc.ts`)
- Backend clients: `{name}.client.ts` (e.g., `git.client.ts`)
- Routers/MCP: `{name}.{type}.ts` (e.g., `terminal.mcp.ts`, `system.mcp.ts`)
- Components: PascalCase `{ComponentName}.tsx` (e.g., `AppSidebar.tsx`, `ResizableLayout.tsx`)
- Component utilities: `{name}.tsx` (e.g., `aspect-ratio.tsx`, `button.tsx`)
- Test files: `{module}.test.ts` or `{module}.spec.ts` (co-located with source)

**Functions:**
- camelCase: `createLogger()`, `generateBranchName()`, `getWorktreePath()`
- Service/client methods: camelCase and non-abbreviated: `fetchAndComputePRState()`, `updateCachedKanbanColumn()`
- Utility functions: descriptive camelCase: `isSystemUserContent()`, `extractUserTextFromMessage()`
- Factory functions: `{name}Factory` or `create{Name}()` pattern (e.g., `GitClientFactory`)

**Variables:**
- camelCase: `mockFindNeedingPRSync`, `currentConcurrent`, `maxConcurrent`
- Constants: ALL_CAPS with underscores: `BASE_DIR`, `LOG_LEVEL`, `DATABASE_PATH`
- Prefixed mocks: `mock{FunctionName}` (e.g., `mockFindNeedingPRSync`, `mockFetchAndComputePRState`)
- Type assertions: included inline (e.g., `envLevel as LogLevel | undefined`)

**Types:**
- Interfaces: PascalCase, descriptive: `CreateWorkspaceInput`, `UpdateWorkspaceInput`, `LoggerConfig`
- Type aliases: PascalCase: `LogLevel`, `HistoryMessage`, `WorkspaceWithSessions`
- Generic types imported from Prisma: Explicit imports from `@prisma-gen/client` (e.g., `Workspace`, `KanbanColumn`)
- Prisma payload types use verbose descriptors: `WorkspaceWithSessions`, `WorkspaceWithProject`
- Union types and literal types: lowercase for primitive string unions (`'error' | 'warn' | 'info' | 'debug'`)
- Optional fields in interfaces: explicitly marked with `?` and/or `| null` for clarity

## Code Style

**Formatting:**
- Tool: Biome v2.3.13
- Indent: 2 spaces (no tabs)
- Line width: 100 characters
- Quotes: Single quotes (`'`) for JavaScript/TypeScript, single quotes for CSS
- Semicolons: Always required (enforced by linter)
- Trailing commas: ES5 style (last element gets comma in objects/arrays)
- Arrow functions required where possible

**Linting:**
- Tool: Biome v2.3.13
- Rules enforcement level: Most set to `"error"`
- Special rule: `noConsole` disabled for specific files: `src/backend/services/logger.service.ts`, `src/lib/debug.ts`, `src/cli/**/*.ts`, `scripts/**/*.ts`, `electron/**/*.ts`

**Key linter rules enforced:**
- Correctness: `noUnusedVariables`, `noUnusedImports`, `noUnusedPrivateClassMembers`, `useExhaustiveDependencies`, `useHookAtTopLevel`
- Style: `useConst`, `useImportType`, `noNonNullAssertion`, `useTemplate`, `useSelfClosingElements`
- Suspicious: `noExplicitAny`, `noDoubleEquals`, `noVar`, `noImplicitAnyLet`, `useAwait`
- Complexity: `noExcessiveCognitiveComplexity`, `useOptionalChain`, `useFlatMap`

## Import Organization

**Order:**
1. Node.js built-in modules (`import { ... } from 'node:...'`)
2. Third-party packages (`import { ... } from '@package'`)
3. Type imports from dependencies (`import type { ... } from '@package'`)
4. Local imports from the project (`import { ... } from '../relative'` or `import { ... } from '@/'`)
5. Type imports from local files (`import type { ... } from './types'`)

**Path Aliases:**
- `@/` → `src/` (absolute import for shared code)
- `@prisma-gen/` → `prisma/generated/` (Prisma generated types)

**Import organization can be auto-fixed:**
```bash
biome check --write .
```

**Examples from codebase:**

```typescript
// Backend service
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../services/logger.service';
import type { ClaudeContentItem, ClaudeJson, ClaudeMessage } from './types';

// Frontend component
import { Outlet } from 'react-router';
import { ResizableLayout } from '@/components/layout/resizable-layout';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/frontend/components/app-sidebar';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider } from '@/frontend/lib/providers';

// Test file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeJson } from './types';
import { schedulerService } from './scheduler.service';
```

## Error Handling

**Patterns:**
- Explicit error throwing with descriptive messages:
  ```typescript
  throw new Error('baseRepoPath is required');
  throw new Error(`Failed to create worktree: ${result.stderr || result.stdout}`);
  ```
- Error messages include context and reason
- Configuration validation at constructor time (fail-fast approach)

**Usage:**
- Check required config in constructor before assignment
- Catch errors in async operations and continue/log as appropriate
- In tests, expect specific error messages: `expect(() => fn()).toThrow('message')`

**Error handling in tests:**
- Mock rejected promises for error scenarios: `mockFn.mockRejectedValue(new Error('msg'))`
- Test both success and error paths explicitly

## Logging

**Framework:** Custom `Logger` class in `src/backend/services/logger.service.ts`

**Patterns:**
- Create logger per module: `const logger = createLogger('module-name')`
- Log levels: `error`, `warn`, `info`, `debug`
- Structured logging with context: `logger.info('message', { context: { key: value } })`
- Child loggers for nested components: `logger.child('sub-component')`
- Logger configured via `LOG_LEVEL` environment variable (default: `'info'`)

**Usage example from codebase:**
```typescript
import { createLogger } from '../services/logger.service';

const logger = createLogger('session');

// In code
logger.info('Session created', { sessionId: '123' });
logger.debug('Parsing history entry', { entryType: entry.type });
```

## Comments

**When to Comment:**
- Explain WHY, not WHAT (code explains what)
- Complex algorithms or non-obvious logic
- Business rules or domain-specific decisions
- Workarounds or hacks with explanation of constraints
- Section headers for large blocks: `// ===== SECTION NAME =====`

**JSDoc/TSDoc:**
- Used for public APIs and utilities
- Describes parameters, return types, and exceptions
- Example from codebase:
  ```typescript
  /**
   * Represents a message from session history
   */
  export interface HistoryMessage {
    type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';
    content: string;
    timestamp: string;
  }
  ```

**Comment conventions:**
- Single-line comments for inline explanations: `// Note: clarifying comment`
- Multi-line block comments for section dividers and detailed explanations
- Avoid redundant comments: `const name = user.name; // get the name` ❌

## Function Design

**Size:** Prefer small, focused functions
- Single responsibility principle
- Functions should fit on one screen (~30-40 lines)
- Extract helper functions for complex logic
- Test functions are exceptions (can be longer for comprehensive coverage)

**Parameters:**
- Use object destructuring for multiple parameters
- Interfaces for complex input types (e.g., `CreateWorkspaceInput`)
- Keep parameter count low (≤ 3 preferred)
- Optional parameters explicitly marked in types

**Return Values:**
- Type explicit return types
- Prefer union types for multiple possible outcomes: `Promise<Result | null>`
- Null/undefined return for "not found" cases
- Throw for actual errors
- Test return values explicitly with assertions like `expect().toHaveLength(1)`

## Module Design

**Exports:**
- Named exports for most items
- Default exports for single primary export (rare)
- Export types explicitly: `export type TypeName = ...` or `export interface ...`

**Barrel Files:**
- Used in some directories for convenient imports
- Example: `src/frontend/components/kanban/index.ts`
- Keep barrel files simple (re-exports only)

**File structure patterns:**
- Service: class instance exported as singleton (e.g., `export const schedulerService = ...`)
- Accessor: class instance exported as singleton (e.g., `export const workspaceAccessor = ...`)
- Client: class with factory pattern (e.g., `GitClient`, `GitClientFactory`)
- Utilities: pure functions exported as named exports

---

*Convention analysis: 2026-01-29*
