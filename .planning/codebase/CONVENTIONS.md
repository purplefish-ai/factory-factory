# Coding Conventions

**Analysis Date:** 2026-02-01

## Naming Patterns

**Files:**
- Backend services: `kebab-case.service.ts` (e.g., `logger.service.ts`, `port.service.ts`, `github-cli.service.ts`)
- Resource accessors: `kebab-case.accessor.ts` (e.g., `claude-session.accessor.ts`, `workspace.accessor.ts`)
- Router files: `kebab-case.router.ts` or `kebab-case.trpc.ts` (e.g., `project.router.ts`, `workspace.trpc.ts`)
- MCP handlers: `kebab-case.mcp.ts` (e.g., `terminal.mcp.ts`, `system.mcp.ts`)
- WebSocket handlers: `kebab-case.handler.ts` (e.g., `chat.handler.ts`, `terminal.handler.ts`)
- Test files: `kebab-case.test.ts` or `kebab-case.spec.ts` (co-located with source)
- React components: `PascalCase.tsx` (e.g., `AppSidebar.tsx`, `ThemeToggle.tsx`)
- React hooks: `use-kebab-case.ts` (e.g., `use-workspace-list-state.ts`, `use-terminal-websocket.ts`)
- Utilities/helpers: `kebab-case.ts` (e.g., `git-helpers.ts`, `file-helpers.ts`)
- Types: `kebab-case.ts` or inline (e.g., `process-types.ts` contains type definitions)

**Functions:**
- camelCase for all function names
- PascalCase for React components and class constructors
- Lowercase with hyphens for file names, never camelCase or snake_case

**Variables:**
- camelCase for all variables and constants at module scope
- Const-first: use `const` by default, only `let` when reassignment needed
- Example: `const mockCreateNetServer`, `const selectedProjectId`, `const logEntry`

**Types:**
- PascalCase for interface and type names: `interface LogEntry`, `type LogLevel`
- PascalCase for class names: `class Logger`, `class SessionManager`
- Suffix types descriptively: `GitStatusFile`, `WorkspaceListItem`, `LoggerConfig`

**Classes and Services:**
- Service classes exported via factory function: `createLogger()` returns `Logger`
- Accessor classes follow pattern: class `ProjectAccessor` in `project.accessor.ts`
- Methods use camelCase and should be descriptive: `parseGitStatusOutput()`, `findAvailablePort()`

## Code Style

**Formatting:**
- Tool: Biome v2.3.13
- Indentation: 2 spaces
- Line width: 100 characters
- Quotes: Single quotes (`'`) for JavaScript/TypeScript, single quotes for CSS
- Semicolons: Always required
- Trailing commas: ES5 style

**Linting:**
- Tool: Biome with strict rules enabled
- Key rules:
  - `noUnusedVariables`: error
  - `noUnusedImports`: error
  - `noUnusedFunctionParameters`: error
  - `noExplicitAny`: error
  - `noDoubleEquals`: error
  - `noConsole`: error (except in logger, debug, CLI, and scripts - see overrides)
  - `useConst`: error (prefer const over let)
  - `useImportType`: error (use `import type` for types)
  - `noNonNullAssertion`: error (don't use `!` operator)
  - `useFragmentSyntax`: error (use `<>` not `<Fragment>`)
  - `noDelete`: error (avoid delete operator)

**Console logging:**
- Disabled globally except in specific files allowed by biome overrides:
  - `src/backend/services/logger.service.ts`
  - `src/lib/debug.ts`
  - `src/cli/**/*.ts`
  - `scripts/**/*.ts`
  - `electron/**/*.ts`

## Import Organization

**Order:**
1. Node.js built-in modules (`import { homedir } from 'node:os'`)
2. Third-party dependencies (`import { z } from 'zod'`)
3. Relative imports from workspace (`import { trpc } from '../lib/trpc'`)
4. Path aliases (`import { createLogger } from '@/backend/services/logger.service'`)
5. Type-only imports at end (`import type { ClaudeJson } from './types'`)

**Path Aliases:**
- `@/*` → `src/`
- `@prisma-gen/*` → `prisma/generated/`
- Use path aliases for cross-module imports to avoid relative path chains
- Import statement organization is automatically handled by Biome's `organizeImports` assist

**Module Resolution:**
- Biome enforces `useNodejsImportProtocol`: use `import ... from 'node:module'` not `import ... from 'module'`
- No `.js` extensions needed in imports (TypeScript/bundler handles resolution)
- Barrel files (`index.ts`) export public API for directories

## Error Handling

**Patterns:**
- Throw `Error` or custom error classes: `throw new Error('message')`
- Catch as typed: `catch (error) { const err = error as Error; }`
- Use try-catch for synchronous operations that may fail
- Use `.catch()` chains for Promise rejection: `promise.catch((err) => { ... })`
- Always log errors with context when catching: `logger.error('Error doing X', error as Error, { context })`
- Return null/undefined for graceful failures in utilities: `return null` instead of throwing when safe

**Error Messages:**
- Start with capital letter, be descriptive
- Include context: `Invalid repository path: ${repoValidation.error}`
- Example: `throw new Error('Could not find an available port starting from 3000')`

**WebSocket/Stream Errors:**
- Classify errors (e.g., `SyntaxError` for JSON parse, other for operational)
- Send structured error responses to client: `{ type: 'error', message: 'description' }`
- Log with full context including request ID or session ID

## Logging

**Framework:** Custom `Logger` class (see `src/backend/services/logger.service.ts`)

**Patterns:**
- Import: `import { createLogger } from '@/backend/services/logger.service'`
- Create instance per module: `const logger = createLogger('ModuleName')`
- Create child loggers for sub-components: `logger.child('SubComponent')`
- Log levels: `error()`, `warn()`, `info()`, `debug()`
- Include context object: `logger.info('message', { key: value })`
- For errors: `logger.error('message', error as Error, { context })`
- Special methods for domain events: `logger.agentEvent()`, `logger.taskEvent()`, `logger.apiCall()`

**When to Log:**
- Errors: Always log with full error object
- External API calls: Log with timing and success/failure
- State transitions: Log lifecycle events (created, started, completed)
- User actions: Log significant operations
- Avoid: Internal function calls, loop iterations (spam)

## Comments

**When to Comment:**
- Complex algorithms: Explain the "why" not the "what"
- Business logic: Explain non-obvious requirements
- Workarounds: Document why a hack exists and when to fix it
- Section dividers: Use `// =============================================================================` for major sections

**JSDoc/TSDoc:**
- Use for public API functions and classes
- Include `@param`, `@returns`, `@throws` tags
- Example:
  ```typescript
  /**
   * Parse git status --porcelain output into structured data.
   * Exported for testing.
   */
  export function parseGitStatusOutput(output: string): GitStatusFile[] {
  ```
- Document service methods and public utilities
- Keep brief - reference code/comments for complexity

## Function Design

**Size:**
- Prefer small, focused functions (< 50 lines)
- Extract helper functions for clarity
- Use descriptive names that explain intent

**Parameters:**
- Maximum 3-4 parameters; use object param for more
- Name parameters descriptively: `workspaceId`, `sessionId`, not `id`
- Use typed objects instead of multiple boolean flags
- Example: `config: { prettyPrint: boolean; serviceName: string }`

**Return Values:**
- Be consistent: return null or undefined, don't mix
- Return typed objects or unions: `Promise<User | null>`, `{ additions: number; deletions: number }`
- For async: Always return a Promise, even if immediately resolved

## Module Design

**Exports:**
- Named exports preferred: `export function helper()`, `export class Service`
- Default exports only for main entry points
- Export types and interfaces that are part of public API: `export type GitFileStatus = 'M' | 'A' | 'D' | '?'`
- Internal helpers: Keep private or prefix with underscore if exposed

**Barrel Files:**
- Use `index.ts` to export public API from a directory
- Don't re-export everything - be selective
- Example: `src/backend/resource_accessors/index.ts` exports main accessors
- Helps with tree-shaking and clear dependency boundaries

**Service Pattern:**
- Services are singletons or factory-created instances
- Use private constructor when singleton pattern applied
- Export factory function: `export function createLogger() { return new Logger(...) }`
- Services should be stateful and maintain context across calls

## Async/Await

**Patterns:**
- Prefer async/await over `.then()` chains
- Use try-catch for async error handling
- Always await Promises to avoid race conditions
- Return Promises from async functions without await wrapper
- Use `Promise.all()` for parallel operations: `await Promise.all([...promises])`

---

*Convention analysis: 2026-02-01*
