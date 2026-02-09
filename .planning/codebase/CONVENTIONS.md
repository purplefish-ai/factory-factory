# Coding Conventions

**Analysis Date:** 2026-02-09

## Naming Patterns

**Files:**
- Services: `.service.ts` suffix (e.g., `git-ops.service.ts`, `terminal.service.ts`)
- Routers/Handlers: `.router.ts` or `.handler.ts` suffix (e.g., `workspace.trpc.ts`, `chat.handler.ts`)
- MCPs (Model Context Protocol): `.mcp.ts` suffix (e.g., `terminal.mcp.ts`, `lock.mcp.ts`)
- Clients: `.client.ts` suffix (e.g., `git.client.ts`, `github-cli.service.ts`)
- Accessors: `.accessor.ts` suffix (e.g., `workspace.accessor.ts`, `claude-session.accessor.ts`)
- Middleware: `.middleware.ts` suffix (e.g., `cors.middleware.ts`, `security.middleware.ts`)
- Utilities/Helpers: `.ts` suffix without special marker (e.g., `git-helpers.ts`, `file-helpers.ts`)
- Schemas: `.schema.ts` suffix (e.g., `tool-inputs.schema.ts`)
- React components: `.tsx` suffix, PascalCase name (e.g., `ErrorBoundary.tsx`, `ProjectLayout.tsx`)

**Functions and Constants:**
- Functions: camelCase (e.g., `getWorkspaceGitStats`, `parseGitStatusOutput`, `createCorsMiddleware`)
- Service instances: camelCase with `Service`/`Client` suffix (e.g., `gitOpsService`, `terminalService`, `gitClientFactory`)
- Exported constants: camelCase (e.g., `trpc`, `devLogsConnections`, `CRITICAL_TOOLS`)
- Router/handler exports: snake_case followed by functionality (e.g., `handleChatUpgrade`, `registerTerminalTools`)
- Private class methods: camelCase with leading underscore (e.g., `_normalizeBranchName`, `_classifyError`)

**Variables:**
- Mutable state: camelCase (e.g., `statusResult`, `worktreeBasePath`, `mockFindById`)
- Function parameters: camelCase (e.g., `branchName`, `worktreePath`, `commitUncommitted`)
- React props interfaces: PascalCase with `Props` suffix (e.g., `ErrorBoundaryProps`)
- Type/Interface names: PascalCase (e.g., `ProjectPaths`, `WorkspaceGitStats`)

**Types:**
- Interfaces: PascalCase, no `I` prefix (e.g., `ProjectPaths`, `ErrorBoundaryProps`, `AppContext`)
- Type aliases: PascalCase (e.g., `WorkspaceGitStats`, `MockRes`)
- Union/enum-like constants: UPPER_SNAKE_CASE (e.g., `READ_ONLY_TOOLS`, `CRITICAL_TOOLS`)

## Code Style

**Formatting:**
- Tool: Biome 2.3.13
- Line width: 100 characters
- Indent: 2 spaces
- Quote style: Single quotes (`'`)
- Trailing commas: ES5 style (no trailing comma in function parameters)
- Semicolons: Always required

**Linting:**
- Tool: Biome (enabled with strict rules)
- No unused imports allowed (rule: `noUnusedImports: error`)
- No unused variables allowed (rule: `noUnusedVariables: error`)
- No console output in production code (rule: `noConsole: error`, except in logger, CLI, scripts)
- No non-null assertions in regular code (rule: `noNonNullAssertion: error`, relaxed in tests)
- No explicit `any` types (rule: `noExplicitAny: error`)
- Must use `const` instead of `let` when value doesn't change (rule: `useConst: error`)
- Import statements must be typed with `import type` for type-only imports (rule: `useImportType: error`)

## Import Organization

**Order:**
1. Node.js built-in modules (`node:fs`, `node:path`)
2. Third-party dependencies (`@trpc/server`, `express`, `react`)
3. Type-only imports from third-party (e.g., `import type { ComponentType }`)
4. Project internal imports using `@/` alias
5. Relative imports (rarely used due to alias preference)

**Path Aliases:**
- `@/*` → `src/*` - Primary alias for all src directory code
- `@prisma-gen/*` → `prisma/generated/*` - Prisma generated types

**Format:**
```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import type { ComponentType } from 'react';
import { gitOpsService } from '@/backend/services/git-ops.service';
import type { WorkspaceGitStats } from '@/backend/services/git-ops.service';
```

## Error Handling

**Patterns:**
- Throw `TRPCError` for API endpoint errors with proper error codes (e.g., `'INTERNAL_SERVER_ERROR'`, `'PRECONDITION_FAILED'`)
- Throw native `Error` for service-level errors with descriptive messages
- Use try-catch for external service calls (git commands, GitHub CLI, file system operations)
- Classify errors before logging (see `github-cli.service.ts` for error classification pattern)
- Always preserve original error message in catch blocks: `error instanceof Error ? error.message : String(error)`

**Example from `git-ops.service.ts`:**
```typescript
const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
if (statusResult.code !== 0) {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Git status failed: ${statusResult.stderr || statusResult.stdout}`,
  });
}
```

## Logging

**Framework:** Console logging via `logger.service.ts`

**Patterns:**
- Create logger instance per module: `const logger = createLogger('module-name')`
- Log levels: `info()`, `debug()`, `warn()`, `error()`
- Include context in error messages (e.g., operation name, relevant IDs)
- Do NOT use console directly except in CLI, scripts, and logger service itself

**Exception:** Biome linter allows console output in:
- `src/backend/services/logger.service.ts`
- `src/lib/debug.ts`
- `src/cli/**/*.ts`
- `scripts/**/*.ts`
- `electron/**/*.ts`

## Comments

**When to Comment:**
- Document non-obvious algorithms or business logic
- Explain WHY code does something, not WHAT it does (code shows what)
- Add comments for workarounds or temporary solutions
- Comment complex conditional logic

**JSDoc/TSDoc:**
- Use `/**` comments for exported functions and classes
- Include `@param` and `@returns` for complex signatures
- Usage is sparse but present - focus on critical public APIs
- Example from `conversation-analyzer.test.ts`:
  ```typescript
  /**
   * Tests for conversation analyzer utilities
   */
  ```

**Biome Ignore Comments:**
- Format: `// biome-ignore lint/category/rule: explanation`
- Example from `error-boundary.tsx`:
  ```typescript
  // biome-ignore lint/suspicious/noConsole: Error logging is intentional for debugging
  console.error('ErrorBoundary caught an error:', error, errorInfo);
  ```

## Function Design

**Size:**
- Keep functions under 50 lines when practical
- Break complex logic into smaller helper functions
- Example: `parseHistoryEntry()` in `session.ts` is comprehensive but split into logical sections by message type

**Parameters:**
- Use object parameters for functions with 3+ parameters
- Use type-safe parameter destructuring
- Validate required parameters in constructor/function start

**Return Values:**
- Use union types for functions that may fail: `{ code: number; stdout: string; stderr: string }`
- Return objects with clear property names for multiple values
- Use Promise for async operations: `async function(): Promise<Type>`

**Example from `git-ops.service.ts`:**
```typescript
async commitIfNeeded(
  worktreePath: string,
  workspaceName: string,
  commitUncommitted: boolean
): Promise<void>
```

## Module Design

**Exports:**
- Export service instances as singletons (e.g., `export const gitOpsService = new GitOpsService()`)
- Export factory functions with `create` prefix (e.g., `createCorsMiddleware`, `createAppContext`)
- Export types and interfaces alongside implementations
- Use `export type` for type-only exports

**Barrel Files:**
- Used in router layers to aggregate handlers
- Example: `src/backend/routers/mcp/index.ts` exports all MCP tool registrations
- Avoid in service layers - import directly from specific service files

**Class vs Functions:**
- Use classes for services with multiple methods and state
- Use exported functions for simple utilities and factories
- Services are instantiated once and exported as singletons

## Special Patterns

**Validation:**
- Use Zod schemas for runtime validation
- Import: `import { z } from 'zod'`
- Pattern: `const schema = z.object({...}); const result = schema.safeParse(input)`
- Always handle `.success` property from `safeParse()` result

**React Component Props:**
- Define interface for all props, even if empty
- Use `type` for prop interfaces (convention in this codebase)
- Props interface example from `error-boundary.tsx`:
  ```typescript
  interface ErrorBoundaryProps {
    children: ReactNode;
    fallback?: ReactNode;
  }
  ```

---

*Convention analysis: 2026-02-09*
