# Coding Conventions

**Analysis Date:** 2026-02-10

## Naming Patterns

**Files:**
- Services: `{name}.service.ts` (e.g., `chat-connection.service.ts`, `logger.service.ts`)
- Clients: `{name}.client.ts` (e.g., `git.client.ts`)
- Routers/Endpoints: `{name}.router.ts` or `{name}.trpc.ts` (e.g., `workspace.trpc.ts`, `health.router.ts`)
- Accessors: `{name}.accessor.ts` (e.g., `project.accessor.ts`, `workspace.accessor.ts`)
- Interceptors: `{name}.interceptor.ts` (e.g., `branch-rename.interceptor.ts`)
- Middleware: `{name}.middleware.ts` (e.g., `cors.middleware.ts`)
- Handlers: `{name}.handler.ts` (e.g., `chat.handler.ts`)
- Test files: `{name}.test.ts` or `{name}.test.tsx` (co-located with source)
- Story files: `{name}.stories.tsx`

**Functions:**
- camelCase for all functions: `generateBranchName()`, `pathExists()`, `createLogger()`
- Private/internal functions use camelCase with underscore prefix is avoided; use private keyword instead
- Async functions use `async` keyword: `async function getWorkspace()`
- Factory functions prefix with `create`: `createLogger()`, `createChatMessageHandlerRegistry()`

**Variables & Constants:**
- camelCase for variables: `dispatchInProgress`, `chatWsMsgCounter`
- CONSTANT_CASE for true constants: `MAX_FILE_SIZE`, `LIB_LIMITS`, `DEBUG_CHAT_WS`
- Object keys follow camelCase: `baseRepoPath`, `worktreeBase`, `dbSessionId`
- Interface properties use camelCase: `workingDir`, `branchName`, `connectionId`

**Types & Interfaces:**
- PascalCase for type names: `ConnectionInfo`, `FileEntry`, `GitWorktreeInfo`, `LogEntry`
- Type names are exported and used explicitly: `export interface ConnectionInfo`
- Discriminated unions use `type` field with string literals: `z.discriminatedUnion('type', [...])`
- Readonly properties marked with `readonly`: `readonly connections: Map<...>`
- Optional properties use `?`: `context?: Record<string, unknown>`

**Classes:**
- PascalCase for class names: `ChatConnectionService`, `GitClient`, `ChatMessageHandlerService`
- Private properties are prefixed with nothing, marked with `private` keyword: `private connections = new Map()`
- Instance methods use camelCase: `register()`, `unregister()`, `tryDispatchNextMessage()`
- Static methods on factories: `GitClientFactory.forProject()`, `GitClientFactory.clearCache()`

## Code Style

**Formatting:**
- Tool: Biome v2.3.13
- Indent: 2 spaces
- Line width: 100 characters
- Quotes: Single quotes (`'string'`) for JavaScript/TypeScript
- Semicolons: Always required
- Trailing commas: ES5 style (in objects/arrays, not function params)

**Linting:**
- Tool: Biome (integrated, runs on `pnpm check:fix`)
- Strict rules enforced via `biome.json`:
  - `noUnusedVariables: error`
  - `noUnusedImports: error`
  - `useConst: error`
  - `useImportType: error`
  - `noNonNullAssertion: error` (disabled in test files and stories)
  - `noConsole: error` (disabled in logger.service.ts, debug.ts, cli/**, scripts/**, electron/**)
  - `noExplicitAny: error`
  - `useAwait: error`
  - `useOptionalChain: error`
  - Cognitive complexity limit enforced with exceptions for known complex files

**Type Checking:**
- Strict TypeScript mode enabled (`strict: true`)
- No implicit any (`noImplicitAny: true`)
- Strict null checks enforced (`strictNullChecks: true`)
- Exhaustive dependencies for React hooks required by linter

## Import Organization

**Order:**
1. Node.js built-in modules: `import * as path from 'node:path'`
2. Third-party packages: `import { z } from 'zod'`
3. Type-only imports from packages: `import type { WebSocket } from 'ws'`
4. Absolute path imports from `@/`: `import { logger } from '@/backend/services/logger.service'`
5. Relative imports: `import { someHelper } from './helpers'`

**Path Aliases:**
- `@/*` → `src/` (used throughout: `@/backend/`, `@/client/`, `@/shared/`, `@/components/`)
- `@prisma-gen/*` → `prisma/generated/`

**Import Style:**
- Prefer named imports: `import { createLogger } from './logger.service'`
- Destructuring in imports: `const { projectId, ...filters } = input`
- Group imports by category (built-in, third-party, internal, relative)
- Use `import type` for type-only imports: `import type { QueuedMessage } from '@/shared/claude'`
- Organize imports automatically: Biome's `organizeImports: on` handles this

## Error Handling

**Patterns:**
- Throw descriptive errors with context: `throw new Error('baseRepoPath is required')`
- Use try-catch in async functions where error classification is needed
- Classify errors by type (see `classifyError()` in `github-cli.service.ts`)
- Log errors with context before throwing: Log message + context object + error details
- Custom error detection methods (private): `isCliNotInstalledError()`, `isAuthRequiredError()`

**Error Messages:**
- Include what failed and why: `Failed to parse gh CLI JSON for ${context}`
- Include the operation context: `throw new Error('Invalid gh CLI response for ${context}')`
- Avoid generic messages; be specific about cause

**Example:**
```typescript
private classifyError(error: unknown): GitHubCLIErrorType {
  const lowerMessage = String(error).toLowerCase();

  if (this.isCliNotInstalledError(lowerMessage)) {
    return 'CLI_NOT_INSTALLED';
  }
  if (this.isAuthRequiredError(lowerMessage)) {
    return 'AUTH_REQUIRED';
  }
  // ... more classification
  return 'UNKNOWN';
}
```

## Logging

**Framework:** Custom structured logger in `src/backend/services/logger.service.ts`

**Patterns:**
- Create named loggers: `const logger = createLogger('module-name')`
- Log levels: error, warn, info, debug
- Include context object in logs: `logger.info('message', { key: value })`
- Log full error objects with stack traces when catching exceptions
- In production, logs write to file (`~/factory-factory/logs/server.log`), errors also to stderr
- Debug flags control verbose output: `if (DEBUG_CHAT_WS) { logger.info(...) }`

**Console usage:**
- Allowed in: `src/backend/services/logger.service.ts`, `src/lib/debug.ts`, `src/cli/**`, `scripts/**`, `electron/**`
- Forbidden elsewhere (linter enforces)

**Example:**
```typescript
const logger = createLogger('chat-connection');
const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

if (DEBUG_CHAT_WS) {
  logger.info('[Chat WS] Dispatch already in progress', { dbSessionId });
}
```

## Comments

**When to Comment:**
- Complex algorithms or non-obvious logic
- Important invariants or constraints (marked with NOTE, IMPORTANT)
- Section headers in services: `// ============================================================================`
- Explaining "why", not "what" (code shows what; comments explain why)
- Business logic that isn't obvious from code

**JSDoc/TSDoc:**
- Used for public APIs and service methods
- Example:
```typescript
/**
 * Validate that a file path doesn't escape the worktree directory.
 * Uses path normalization and realpath to handle encoded sequences,
 * symlinks, and other bypass attempts.
 */
export async function isPathSafe(worktreePath: string, filePath: string): Promise<boolean>
```

**Section Headers:**
Services use visual section separators for readability:
```typescript
// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Service
// ============================================================================
```

## Function Design

**Size:**
- Keep functions focused; extract complex logic to separate functions
- Large functions (like `protocol.ts`, `run-script.service.ts`) have exceptions noted in `biome.json` for `noExcessiveCognitiveComplexity`

**Parameters:**
- Use object destructuring for multiple parameters: `{ projectId, ...filters } = input`
- Required params first, optional params in object at end
- Type parameters explicitly: all params have types

**Return Values:**
- Async functions return `Promise<T>`
- Use `Promise.resolve()` or direct return in async functions
- Explicitly type return values in signatures
- Use discriminated unions for complex return types (like workspace state)

**Example:**
```typescript
async function tryDispatchNextMessage(dbSessionId: string): Promise<void> {
  if (this.dispatchInProgress.get(dbSessionId)) {
    return; // Early return for guard clause
  }

  const msg = sessionDomainService.dequeueNext(dbSessionId, { emitSnapshot: false });
  if (!msg) {
    return; // No message to dispatch
  }

  // ... rest of logic
}
```

## Module Design

**Exports:**
- Named exports preferred: `export const workspaceRouter = router({...})`
- Export types alongside implementation: `export type ChatMessage = ChatMessageInput`
- Singleton instances exported: `export const chatConnectionService = new ChatConnectionService()`
- Factory instances exported: `export const GitClientFactory = { forProject, removeProject, ... }`

**Barrel Files:**
- Used in `src/backend/resource_accessors/index.ts`, `src/backend/routers/index.ts`
- Re-export all public modules: `export * from './workspace.accessor'`
- Simplifies imports for consumers

**Service Pattern:**
- Services are singletons, instantiated once and exported
- Example from `chat-connection.service.ts`:
```typescript
class ChatConnectionService {
  private connections = new Map<string, ConnectionInfo>();

  register(connectionId: string, info: ConnectionInfo): void { ... }
  unregister(connectionId: string): void { ... }
}

export const chatConnectionService = new ChatConnectionService();
```

## Zod Validation

**Pattern:**
- All input validation uses Zod schemas
- Schemas are defined inline in procedures or extracted to constants
- Discriminated unions for complex types: `z.discriminatedUnion('type', [...])`
- Use `z.object()` for request/response validation
- Example:
```typescript
export const workspaceRouter = router({
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(({ input }) => { ... })
});
```

## Database & Prisma

**ORM:** Prisma with better-sqlite3 adapter

**Patterns:**
- Types generated to `@prisma-gen/*`: `import { KanbanColumn } from '@prisma-gen/client'`
- Client accessed from context in tRPC procedures: `prisma.workspace.findUnique(...)`
- Migrations in `prisma/migrations/`
- Schema in `prisma/schema.prisma`

---

*Convention analysis: 2026-02-10*
