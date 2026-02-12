# Stage 6: Finalize API, Integration Tests, and npm Publish

**Risk**: Low
**Depends on**: Stage 5 (all domain extraction complete)
**Estimated scope**: ~10 new/modified files

## Goal

Clean up the core public API surface, add consumer-facing integration tests, and prepare `@factory-factory/core` for npm publication. This is the final stage -- after this, the library is usable by external consumers (including the future FF Cloud product).

## What Gets Done

### Part A: Clean Up Public API

Review and finalize `packages/core/src/index.ts`. The public API should be intentional -- every export is a deliberate part of the library contract.

**Exports organized by category:**

```typescript
// packages/core/src/index.ts

// --- Types & Enums ---
export {
  WorkspaceStatus, SessionStatus, PRState, CIStatus,
  KanbanColumn, RatchetState, WorkspaceCreationSource, RunScriptStatus,
} from './types/enums.js';

// --- Storage Interfaces ---
export type {
  WorkspaceStorage, WorkspaceRecord, RatchetWorkspaceView,
  CIMonitoringView, ReviewMonitoringView,
} from './storage/workspace-storage.js';
export type {
  SessionStorage, SessionRecord, SessionWithWorkspace,
  CreateSessionInput, AcquireFixerSessionInput, FixerSessionAcquisition,
} from './storage/session-storage.js';

// --- Infrastructure Interfaces ---
export type { Logger, CreateLogger } from './infra/logger.js';
export type { CoreServiceConfig } from './infra/config.js';

// --- Claude Protocol & Process Management ---
export { ClaudeClient, type ClaudeClientOptions, type ClaudeClientDeps } from './claude/client.js';
export { ClaudeProcess, type ClaudeProcessOptions, type ExitResult } from './claude/process.js';
export { ClaudeProtocol, type ControlResponseBody } from './claude/protocol.js';
export { ClaudeProtocolIO, type ProtocolIO } from './claude/protocol-io.js';
export { ProcessRegistry, processRegistry } from './claude/registry.js';
export { SessionManager } from './claude/session.js';
export { ClaudeProcessMonitor } from './claude/monitoring.js';
export { ClaudePermissionCoordinator } from './claude/permission-coordinator.js';
export {
  AutoApproveHandler, DeferredHandler, ModeBasedHandler,
} from './claude/permissions.js';
// Claude protocol types (selective)
export type {
  AssistantMessage, UserMessage, SystemMessage, ResultMessage,
  StreamEventMessage, ControlRequest, ToolUseContent, ClaudeJson,
  PermissionMode, HooksConfig,
} from './claude/types.js';
export type { ProcessStatus, ResourceUsage } from './claude/types/process-types.js';

// --- Workspace ---
export { deriveWorkspaceFlowState, type WorkspaceFlowState } from './workspace/flow-state.js';
export { getWorkspaceInitPolicy } from './workspace/init-policy.js';
export { computeKanbanColumn } from './workspace/kanban-column.js';
export { WorkspaceStateMachine } from './workspace/state-machine.service.js';
export { WorkspaceActivityService } from './workspace/activity.service.js';
export type { WorkspaceSessionBridge, WorkspaceGitHubBridge, WorkspacePRSnapshotBridge } from './workspace/bridges.js';

// --- Session ---
export { SessionService } from './session/session.service.js';
export { SessionDomainService } from './session/session-domain.service.js';
export { SessionProcessManager } from './session/process-manager.js';
export { SessionRepository } from './session/repository.js';
export type { SessionWorkspaceBridge, SessionInitPolicyBridge } from './session/bridges.js';

// --- Ratchet ---
export { RatchetService, type RatchetServiceDeps } from './ratchet/ratchet.service.js';
export { CIFixerService } from './ratchet/ci-fixer.service.js';
export { CIMonitorService } from './ratchet/ci-monitor.service.js';
export { FixerSessionService } from './ratchet/fixer-session.service.js';
export type {
  RatchetSessionBridge, RatchetGitHubBridge,
  RatchetPRSnapshotBridge, RatchetWorkspaceBridge,
} from './ratchet/bridges.js';

// --- Shared Utilities ---
export { computeOverallCIStatus } from './shared/ci-status.js';
export { deriveSidebarStatus } from './shared/workspace-sidebar-status.js';

// --- Testing Utilities ---
export { createMockWorkspaceStorage } from './testing/mock-storage.js';
export { createMockSessionStorage } from './testing/mock-storage.js';
export { createMockRatchetSessionBridge } from './testing/mock-bridges.js';
```

**Rules for public API:**
- Every exported symbol has JSDoc documentation
- No `any` types in public signatures
- No internal implementation details exposed
- Bridge interfaces are exported as `type` (no runtime value)
- Testing utilities exported for downstream consumers

### Part B: Integration Tests

Create consumer-facing integration tests that exercise the public API as a black box.

```typescript
// packages/core/src/__tests__/integration/ratchet-workflow.test.ts
describe('Ratchet workflow (integration)', () => {
  it('can create and configure a RatchetService with mock storage', () => {
    const service = new RatchetService();
    service.configure({
      createLogger: mockCreateLogger,
      workspaceStorage: createMockWorkspaceStorage(),
      sessionStorage: createMockSessionStorage(),
      config: defaultTestConfig,
    });
    service.configureBridges({
      session: createMockRatchetSessionBridge(),
      github: createMockRatchetGitHubBridge(),
      prSnapshot: createMockRatchetPRSnapshotBridge(),
    });
    expect(service).toBeDefined();
  });

  it('polls workspaces and dispatches fixes', async () => {
    // Set up mock storage to return a workspace with failing CI
    // Configure bridges to simulate GitHub API responses
    // Start ratchet, verify it creates a fixer session
  });
});
```

```typescript
// packages/core/src/__tests__/integration/session-lifecycle.test.ts
describe('Session lifecycle (integration)', () => {
  it('can create a session and track its state', async () => {
    // Create SessionService with mock storage
    // Create a session, verify state transitions
  });
});
```

```typescript
// packages/core/src/__tests__/integration/workspace-state.test.ts
describe('Workspace state machine (integration)', () => {
  it('transitions through workspace lifecycle', async () => {
    // Create WorkspaceStateMachine with mock storage
    // Test: NEW -> PROVISIONING -> READY -> ARCHIVED
  });
});
```

### Part C: Package Configuration for npm

Update `packages/core/package.json`:

```json
{
  "name": "@factory-factory/core",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "description": "Core library for Factory Factory workspace execution primitives",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/purplefish-ai/factory-factory.git",
    "directory": "packages/core"
  },
  "homepage": "https://factoryfactory.ai",
  "keywords": [
    "factory-factory", "claude", "claude-code", "ai", "workspace",
    "session", "ratchet", "auto-fix"
  ],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm run build && pnpm run test"
  }
}
```

### Part D: Update dependency-cruiser

Update `.dependency-cruiser.cjs` to handle the new package boundary:

- Allow desktop code to import from `@factory-factory/core`
- Ensure core does not import from desktop (`@/*`, `@prisma-gen/*`)
- Update `no-cross-domain-imports` rule to account for domains that are now re-export layers

### Part E: README for Core Package

Create `packages/core/README.md` with:
- Package description and purpose
- Installation instructions
- Quick start example (create a service, provide storage, run)
- API overview with links to JSDoc
- License

## New Files

```
packages/core/
  README.md
  LICENSE                        # Copy of root LICENSE
  src/
    __tests__/
      integration/
        ratchet-workflow.test.ts
        session-lifecycle.test.ts
        workspace-state.test.ts
    index.ts                     # Finalized public API
```

## Modified Files

- `packages/core/package.json` -- publish config
- `packages/core/src/index.ts` -- finalized exports
- `.dependency-cruiser.cjs` -- updated rules
- Root `package.json` -- verify workspace:* dependency

## Tests to Add

- 3 integration test suites (ratchet workflow, session lifecycle, workspace state)
- Public API smoke test: import every exported symbol and verify it's defined

## Verification Checklist

```bash
# Full monorepo build
pnpm -r build

# Full test suite
pnpm -r test

# Type check everything
pnpm typecheck

# Lint
pnpm check:fix

# Pack core to verify publishable content
pnpm --filter @factory-factory/core pack
# Inspect the tarball: ensure only dist/, README.md, LICENSE are included

# Dry-run publish
pnpm --filter @factory-factory/core publish --dry-run

# Integration verification: install packed tarball in a scratch project
mkdir /tmp/ff-core-test && cd /tmp/ff-core-test
npm init -y && npm install /path/to/factory-factory-core-0.1.0.tgz
node -e "const core = require('@factory-factory/core'); console.log(Object.keys(core))"
```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Accidentally exposing internal types | Medium | Explicit export list in index.ts; review each export |
| Missing dependency in core package.json | Medium | Integration test in scratch project catches this |
| Large tarball size | Low | `"files"` field limits to dist/ only |
| Breaking change in public API | N/A | This is v0.1.0; semver allows breaking changes before 1.0 |

## npm Publishing Process

1. Ensure all tests pass: `pnpm -r test`
2. Build core: `pnpm --filter @factory-factory/core build`
3. Verify package contents: `pnpm --filter @factory-factory/core pack`
4. Publish: `pnpm --filter @factory-factory/core publish --access public`
5. Verify: `npm info @factory-factory/core`

For subsequent releases, use semantic versioning:
- Patch (0.1.x): Bug fixes, no API changes
- Minor (0.x.0): New features, backward compatible
- Major (x.0.0): Breaking API changes

## What Success Looks Like

After Stage 6:
- `@factory-factory/core` is published on npm
- Desktop app works identically (uses `workspace:*` in dev, published version in CI)
- A cloud consumer can `npm install @factory-factory/core` and:
  - Implement `WorkspaceStorage` and `SessionStorage` with their own database
  - Provide a `CreateLogger` function for their logging framework
  - Create `RatchetService`, `SessionService`, `WorkspaceStateMachine` instances
  - Manage Claude CLI processes via `ClaudeClient`
  - All with full TypeScript type safety
