# Factory Factory Backend Architecture Analysis

**Generated:** 2026-02-09
**Backend Modules Analyzed:** 202
**Circular Dependencies:** 0 ✓

---

## 🔥 Critical Hotspots

### 1. **logger.service.ts** - 64 dependents
**Impact:** CRITICAL - Changes affect 31% of codebase
**Type:** Infrastructure utility
**Risk:** Low (stable interface)

**Action:** ✅ Already well-designed as a pure utility. Keep as-is.

---

### 2. **workspace.accessor.ts** - 27 dependents
**Impact:** HIGH - Core data access layer
**Type:** Data accessor (Prisma)
**Current violations:** None

**Concern:** Being used by multiple layers:
- ✅ `services/` (expected) - 17 imports
- ⚠️  `interceptors/` (questionable) - 2 imports
- ⚠️  `routers/` (violation?) - 1 import

**Action:**
```javascript
// Add to dependency-cruiser.cjs
{
  name: "no-routers-importing-accessors-directly",
  severity: "warn",
  comment: "Routers should use services, not access data directly",
  from: { path: "^src/backend/routers" },
  to: { path: "^src/backend/resource_accessors" },
}
```

---

### 3. **session.service.ts** - 27 dependents
**Impact:** HIGH - Session lifecycle orchestration
**Type:** Business logic
**Dependencies:** 11 modules (moderate coupling)

**Concern:** Central orchestrator for sessions, but has 97 service-to-service dependencies total across all services.

**Architecture smell detected:**
```
chat-event-forwarder.service → session-store.service
chat-event-forwarder.service → session.service
session-store.service → session-file-logger.service
ratchet.service → session.service
ratchet.service → session-store.service
```

This creates a **session dependency graph** that could be simplified.

**Action:** Consider extracting a `SessionAggregate` domain module:

```
src/backend/domain/session/
├── index.ts                    # Public API only
├── session.entity.ts           # Core domain model
├── session.repository.ts       # Interface (implemented in infrastructure)
├── transcript.ts               # Message aggregate (YOUR CONCERN!)
└── events.ts                   # Domain events
```

---

## 🌊 Data Flow Issues: Message/Transcript Handling

You mentioned concern about **message durability and dual writes**. Analysis shows:

### Current Message Flow Architecture

**48 modules** touch session/message/transcript concerns:

```
┌─────────────────────────────────────────────────────┐
│ Frontend (WebSocket)                                │
└───────────┬─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│ chat.handler.ts (entry point)                       │
└───────────┬─────────────────────────────────────────┘
            │
            ├─► chat-event-forwarder.service ──┐
            │                                   │
            ├─► chat-message-handlers.service ─┤
            │                                   │
            └─► session.service ────────────────┤
                                                │
                                                ▼
                ┌───────────────────────────────────┐
                │ session-store.service             │
                │ (in-memory transcript)            │
                └───────────┬───────────────────────┘
                            │
                ├───────────┼────────────────┐
                ▼           ▼                ▼
    ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
    │ WebSocket   │  │ File Logger  │  │ Claude CLI   │
    │ (clients)   │  │ (.log files) │  │ (.jsonl)     │
    └─────────────┘  └──────────────┘  └──────────────┘
```

### 🚨 Divergence Risk Points

1. **session-store.service.ts**
   - Manages in-memory transcript (line 40: `transcript: ChatMessage[]`)
   - Emits to WebSocket (line 90: `emitDelta`)
   - BUT doesn't directly persist to disk

2. **session-file-logger.service.ts**
   - Logs ALL events to `.context/ws-logs/` for debugging
   - This is audit trail, NOT source of truth

3. **claude/session.ts**
   - Reads from `~/.claude/projects/*/session-id.jsonl` (line 80)
   - Hydrates history (line 73-76: `parseHistoryFromPath`)
   - BUT doesn't write - Claude CLI owns this

**The Problem:** Three separate concerns mixed together:
- ❌ Transcript state (in-memory)
- ❌ Audit logging (files)
- ❌ Persistence (Claude CLI's .jsonl)

### ✅ Recommended Solution

Create a **Message Aggregate** with single write path:

```typescript
// src/backend/domain/message/transcript.ts
export class Transcript {
  private constructor(
    private readonly sessionId: string,
    private messages: Message[],
    private persistence: TranscriptPersistence  // Interface
  ) {}

  async append(message: Message): Promise<void> {
    // 1. Domain validation
    this.validateSequencing(message);

    // 2. Update in-memory (immutable)
    const newMessages = [...this.messages, message];

    // 3. Single persistence call (handles ALL storage)
    await this.persistence.persist(this.sessionId, message);

    // 4. Commit in-memory only after successful persist
    this.messages = newMessages;

    // 5. Emit event for side effects (WebSocket, logging)
    this.emit('message:appended', message);
  }

  // NO OTHER WAY TO MUTATE MESSAGES
}

// Infrastructure implements this interface
export interface TranscriptPersistence {
  persist(sessionId: string, message: Message): Promise<void>;
  hydrate(sessionId: string): Promise<Message[]>;
}
```

This ensures:
✅ Single code path for ALL writes
✅ Atomicity (persist → commit)
✅ Events for cross-cutting concerns (WebSocket, audit logs)
✅ No divergence possible

---

## 📊 Layer Coupling Summary

| Layer | Modules | Avg Coupling | Assessment |
|-------|---------|--------------|------------|
| **app-context.ts** | 1 | 35.0 | ⚠️ Central hub - by design |
| **services** | 91 | 6.9 | ⚠️ HIGH - needs decomposition |
| **resource_accessors** | 9 | 9.4 | ✅ Appropriate for data layer |
| **claude** | 17 | 6.6 | ⚠️ Mixed concerns (protocol + domain) |
| **trpc** | 20 | 5.7 | ✅ Good |
| **routers** | 18 | 5.1 | ✅ Good |

### Cross-Layer Dependencies (Top Issues)

1. **services → resource_accessors (35x)** ✅ EXPECTED
2. **services → claude (22x)** ⚠️ CONCERN - `claude/` should be infrastructure
3. **app-context → services (21x)** ✅ EXPECTED (DI container)
4. **trpc → resource_accessors (15x)** ⚠️ SHOULD USE SERVICES

---

## 🎯 Action Plan

### Phase 1: Quick Wins (This Week)

1. **Add dependency-cruiser rules** to prevent regression:

```javascript
// Add to .dependency-cruiser.cjs
{
  name: "no-trpc-to-accessors",
  severity: "error",
  comment: "tRPC should use services, not access data directly",
  from: { path: "^src/backend/trpc" },
  to: { path: "^src/backend/resource_accessors" },
},
{
  name: "services-coupling-warning",
  severity: "warn",
  comment: "Service importing another service - consider extracting shared domain logic",
  from: { path: "^src/backend/services/(.+)\\.service\\.ts$" },
  to: { path: "^src/backend/services/(.+)\\.service\\.ts$" },
}
```

2. **Document current architecture** in `ARCHITECTURE.md`:
   - Layer responsibilities
   - Dependency rules
   - Message flow diagram

3. **Run dependency analysis monthly:**
   ```bash
   pnpm deps:check --output-type metrics > .architecture/metrics-$(date +%Y-%m).json
   ```

### Phase 2: Extract Message Domain (Next 2 Weeks)

1. Create `src/backend/domain/message/` module
2. Move transcript logic from `session-store.service.ts`
3. Define `TranscriptPersistence` interface
4. Implement in `src/backend/infrastructure/persistence/claude-transcript.persistence.ts`
5. Update consumers to use new aggregate

### Phase 3: Refactor Services Layer (Next Month)

**Current:** 91 service files (too many!)

**Target structure:**

```
src/backend/
├── domain/              # Business entities & rules
│   ├── session/
│   ├── workspace/
│   ├── message/
│   └── project/
├── application/         # Use cases & orchestration
│   ├── session-lifecycle/
│   ├── workspace-management/
│   └── chat-handling/
├── infrastructure/      # Implementation details
│   ├── persistence/     # Prisma, file I/O
│   ├── claude-cli/      # Process management
│   └── websocket/
└── interfaces/          # API layer
    ├── trpc/
    ├── websocket/
    └── mcp/
```

Break down services into:
- Domain services (business logic)
- Application services (orchestration)
- Infrastructure services (technical concerns)

---

## 📈 Metrics to Track

Run monthly and track trends:

```bash
# Total module count
pnpm depcruise src/backend --output-type json | jq '.modules | length'

# Average coupling per layer
node /tmp/analyze-deps.mjs > metrics-$(date +%Y-%m).txt

# Service-to-service dependencies
# Target: < 50 (currently 97)
```

**Success Metrics:**
- ✅ Zero circular dependencies (current: 0)
- 🎯 Service-to-service coupling < 50 (current: 97)
- 🎯 Average service coupling < 5.0 (current: 6.9)
- 🎯 Cross-layer violations = 0

---

## 🔍 Tools Setup

Install additional tooling:

```bash
# Visualize dependencies interactively
pnpm add -D madge
npx madge --image deps-graph.svg src/backend

# Check for unused exports (dead code)
pnpm add -D ts-prune
npx ts-prune

# Module boundaries enforcement
pnpm add -D eslint-plugin-boundaries
```

---

## 🚧 Anti-Patterns Detected

1. **God Service Pattern:** Some services do too much
   - `session.service.ts` - lifecycle + orchestration + state
   - `workspace-query.service.ts` - 11 dependencies

2. **Service Chain:** Services calling services calling services
   - `worktree-lifecycle → session → session.process-manager`
   - Refactor to: Application service coordinates domain + infrastructure

3. **Leaky Abstraction:**
   - `trpc/` importing `resource_accessors` directly (15x)
   - Should use services layer

4. **Mixed Concerns in `claude/`:**
   - Protocol (infrastructure)
   - Session parsing (domain)
   - Process management (infrastructure)

---

## ✅ What's Working Well

1. **No circular dependencies** - Great discipline!
2. **Clear data layer** - `resource_accessors` well-defined
3. **Dependency-cruiser** already in place and enforcing rules
4. **Layer separation** - routers → services → accessors mostly followed

---

## 📚 References

- [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
- [DDD Aggregates](https://martinfowler.com/bliki/DDD_Aggregate.html)
- [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser)
- [Module Boundaries](https://github.com/javierbrea/eslint-plugin-boundaries)

---

## Next Steps

1. Review this analysis
2. Decide on domain boundaries (Session, Workspace, Message)
3. Start with Message/Transcript refactoring (your immediate concern)
4. Add stricter dependency-cruiser rules incrementally
5. Set up monthly architecture review meetings
