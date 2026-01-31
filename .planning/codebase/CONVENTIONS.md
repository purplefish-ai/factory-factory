# Coding Conventions

**Analysis Date:** 2026-01-31

## Style & Formatting

**Tool:** Biome (v2.3.13)
**Configuration:** `biome.json`

**Key Style Rules:**
- Indent: 2 spaces
- Line width: 100 characters
- Semicolons: Always
- Quote style: Single quotes for JavaScript/TypeScript
- Trailing commas: ES5 compatible

**Linting:**
- Biome handles both linting and formatting
- No ESLint/Prettier (replaced by Biome)
- Custom Grit plugins: `biome-rules/no-await-import.grit`, `biome-rules/no-native-dialogs.grit`

**Run commands:**
```bash
pnpm check:fix    # Lint + format with Biome
pnpm typecheck    # TypeScript checking only
```

## Naming Conventions

**Files:**
- Components: `kebab-case.tsx` (e.g., `button.tsx`, `chat-input.tsx`)
- Services: `kebab-case.service.ts` (e.g., `scheduler.service.ts`, `logger.service.ts`)
- Accessors: `kebab-case.accessor.ts` (e.g., `workspace.accessor.ts`)
- Tests: `*.test.ts` co-located with source (e.g., `protocol.test.ts`)
- Stories: `*.stories.tsx` co-located with component (e.g., `button.stories.tsx`)
- tRPC routers: `kebab-case.trpc.ts` (e.g., `workspace.trpc.ts`)
- Types: `kebab-case.ts` or `types.ts` (e.g., `claude-types.ts`)

**Functions:**
- camelCase for functions and methods
- Use verb prefixes: `create`, `get`, `find`, `update`, `delete`, `is`, `has`
```typescript
function createLogger(component: string): Logger {}
async function findById(id: string): Promise<Workspace | null> {}
function isPortAvailable(port: number): Promise<boolean> {}
```

**Variables:**
- camelCase for variables and parameters
- UPPER_SNAKE_CASE for constants
```typescript
const STALE_THRESHOLD_MINUTES = 5;
const MAX_CONCURRENT_PR_SYNCS = 5;
```

**Types/Interfaces:**
- PascalCase for types, interfaces, and classes
- Suffix with purpose: `Input`, `Output`, `Options`, `Config`, `State`, `Action`
```typescript
interface CreateWorkspaceInput {}
interface LoggerConfig {}
type ChatAction = { type: 'WS_STATUS'; payload: { running: boolean } } | ...
```

**React Components:**
- PascalCase for component names
- Use `forwardRef` for components that need refs
```typescript
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(...)
Button.displayName = 'Button';
```

## Code Patterns

**Service Pattern:**
- Class-based singletons with factory function or direct instance export
- Location: `src/backend/services/`
```typescript
class SchedulerService {
  private syncInterval: NodeJS.Timeout | null = null;
  start(): void { ... }
  async stop(): Promise<void> { ... }
}
export const schedulerService = new SchedulerService();
```

**Logger Factory:**
- Use `createLogger(component)` to get a logger instance
```typescript
import { createLogger } from './logger.service';
const logger = createLogger('scheduler');
logger.info('Starting sync', { count: 5 });
logger.error('Sync failed', error as Error, { workspaceId });
```

**Accessor Pattern:**
- Database access via accessor classes
- Location: `src/backend/resource_accessors/`
```typescript
class WorkspaceAccessor {
  create(data: CreateWorkspaceInput): Promise<Workspace> { ... }
  findById(id: string): Promise<Workspace | null> { ... }
  update(id: string, data: UpdateWorkspaceInput): Promise<Workspace> { ... }
}
export const workspaceAccessor = new WorkspaceAccessor();
```

**tRPC Router Pattern:**
- Use Zod for input validation
- Location: `src/backend/trpc/`
```typescript
export const projectRouter = router({
  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const project = await projectAccessor.findById(input.id);
      if (!project) {
        throw new Error(`Project not found: ${input.id}`);
      }
      return project;
    }),
});
```

**React Component Pattern:**
- Use CVA (class-variance-authority) for variant-based styling
- Location: `src/components/ui/`
```typescript
const buttonVariants = cva(
  'inline-flex items-center justify-center...',
  {
    variants: {
      variant: { default: '...', destructive: '...' },
      size: { default: '...', sm: '...', lg: '...' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
```

**State Management (Frontend):**
- Reducer pattern for complex state
- Location: `src/components/chat/chat-reducer.ts`
```typescript
type ChatAction =
  | { type: 'WS_STATUS'; payload: { running: boolean } }
  | { type: 'WS_CLAUDE_MESSAGE'; payload: ClaudeMessage }
  | ...;

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_STATUS':
      return { ...state, sessionStatus: ... };
    ...
  }
}
```

## Import Organization

**Order (enforced by Biome organizeImports):**
1. Node.js built-in modules (with `node:` protocol)
2. External packages
3. Internal modules using path aliases

**Path Aliases:**
- `@/*` → `src/*`
- `@prisma-gen/*` → `prisma/generated/*`

**Examples:**
```typescript
// Node built-ins first
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';

// External packages
import { z } from 'zod';
import pLimit from 'p-limit';

// Internal via aliases
import type { Workspace } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { createLogger } from '@/backend/services/logger.service';
```

**Import Type:**
- Use `import type` for type-only imports (enforced by Biome `useImportType`)
```typescript
import type { Workspace, WorkspaceStatus } from '@prisma-gen/client';
```

## Error Handling

**Throw descriptive errors:**
```typescript
if (!project) {
  throw new Error(`Project not found: ${input.id}`);
}
if (finalCommand && finalPath) {
  throw new Error(
    'Cannot have both startupScriptCommand and startupScriptPath set. Please clear one by setting it to null.'
  );
}
```

**Logger for non-throwing errors:**
```typescript
try {
  await this.syncSinglePR(workspace.id, workspace.prUrl);
} catch (error) {
  logger.error('PR sync failed for workspace', error as Error, { workspaceId, prUrl });
  return { success: false, reason: 'error' };
}
```

**Graceful degradation:**
```typescript
const result = await githubCLIService.fetchAndComputePRState(prUrl);
if (!result) {
  logger.warn('Failed to fetch PR status', { workspaceId, prUrl });
  return { success: false, reason: 'fetch_failed' };
}
```

## Comments & Documentation

**File headers:** Use JSDoc-style block comments for file purpose
```typescript
/**
 * Scheduler Service
 *
 * Local background job scheduler for periodic tasks.
 * Replaces Inngest for PR status sync.
 */
```

**Section dividers:** Use commented lines for visual organization
```typescript
// =============================================================================
// Test Setup
// =============================================================================

// -------------------------------------------------------------------------
// WS_STATUS Action
// -------------------------------------------------------------------------
```

**Interface/Type documentation:**
```typescript
/**
 * Threshold for considering a PROVISIONING workspace as stale.
 * Workspaces in PROVISIONING state for longer than this are considered
 * stuck (e.g., due to server crash) and will be recovered by reconciliation.
 */
const STALE_PROVISIONING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
```

**Function documentation:** Use JSDoc for public API functions
```typescript
/**
 * Batch sync PR status for all workspaces with stale PR data.
 * Can also be called manually to trigger an immediate sync.
 */
async syncPRStatuses(): Promise<{ synced: number; failed: number }> { ... }
```

## TypeScript Specifics

**Strict mode:** Enabled with all strict flags in `tsconfig.json`

**No explicit any:** Use `unknown` and narrow types instead

**Use const assertions:**
```typescript
const AVAILABLE_MODELS: ModelInfo[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
];
```

**Discriminated unions for state:**
```typescript
type PendingRequest =
  | { type: 'none' }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'question'; request: UserQuestionRequest };
```

**Prisma types for database relations:**
```typescript
type WorkspaceWithSessions = Prisma.WorkspaceGetPayload<{
  include: { claudeSessions: true; terminalSessions: true };
}>;
```

---

*Convention analysis: 2026-01-31*
