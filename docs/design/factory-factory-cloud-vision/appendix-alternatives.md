# Appendix: Alternative Approaches Considered

We evaluated two architectural approaches before choosing Approach #2 (Library-based). This appendix documents both approaches and the reasoning behind the decision.

## Approach #1: Decoupled FF Cloud + Full FF-per-VM

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                    FF Cloud Server                          │
│  - User management & authentication                         │
│  - Billing & quotas                                         │
│  - VM orchestration (create/destroy VMs)                    │
│  - User → VM mapping (PostgreSQL)                           │
│  - WebSocket relay (forwards to user's VM)                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  VM (User A)     │  │  VM (User B)     │  │  VM (User C)     │
│  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────┐  │
│  │ FF Server  │  │  │  │ FF Server  │  │  │  │ FF Server  │  │
│  │ (full)     │  │  │  │ (full)     │  │  │  │ (full)     │  │
│  ├────────────┤  │  │  ├────────────┤  │  │  ├────────────┤  │
│  │ SQLite DB  │  │  │  │ SQLite DB  │  │  │  │ SQLite DB  │  │
│  ├────────────┤  │  │  ├────────────┤  │  │  ├────────────┤  │
│  │ Workspace1 │  │  │  │ Workspace1 │  │  │  │ Workspace1 │  │
│  │ Workspace2 │  │  │  │ Workspace2 │  │  │  │ Workspace2 │  │
│  │ Workspace3 │  │  │  │ Workspace3 │  │  │  │ Workspace3 │  │
│  │ ...        │  │  │  │ ...        │  │  │  │ ...        │  │
│  └────────────┘  │  │  └────────────┘  │  │  └────────────┘  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

**Key Characteristics:**
- **One VM per user** with **full FF server** inside (Express, SQLite, WebSocket handlers)
- **Multiple workspaces** (5-10) per VM, each with its own Claude CLI subprocess
- **Desktop migration**: Desktop uploads workspace state to cloud, then disconnects (can pull back later)
- **Two codebases**: FF Cloud (orchestration) + FF (workspace execution)

**Pros:**
- Strong user isolation: Each user's VM is completely independent
- Reuses existing FF codebase: VMs run the same FF that works on desktop
- Minimal FF modifications: FF doesn't need to know about multi-tenancy
- Independent scaling: Spin up/down VMs per user
- Version flexibility: Different users can run different FF versions
- Desktop parity: Cloud workspaces behave exactly like desktop workspaces

**Cons:**
- Two codebases to maintain: FF Cloud orchestration layer + FF server
- Higher resource cost: Full FF server (Node.js + SQLite) per user (~200MB per VM)
- More complex deployment: Orchestrate FF Cloud + provision/manage user VMs
- Team features harder: Cross-user data (manager view) requires querying multiple VMs
- Duplicate logic: Workspace management exists in both FF Cloud and FF Server
- VM-to-VM overhead: If users share workspaces, VMs need to communicate

## Approach #2: Library-based FF Cloud Server (Chosen)

See [README.md](./README.md) for the full design of the chosen approach.

**Key Characteristics:**
- **FF Cloud server** (closed source) handles multi-tenancy, orchestration, billing
- **FF core** (open source) runs in VMs, provides workspace execution primitives
- **Clean separation**: Open source workspace logic, closed source cloud infrastructure

## Detailed Comparison

| Dimension | Approach #1 (Decoupled) | Approach #2 (Library-based) |
|-----------|-------------------------|--------------------------|
| **Codebases** | 2 (FF Cloud + FF Server) | 2 (FF Cloud + FF Core lib) |
| **Open source** | FF Server (full app) | FF Core (library only) |
| **Closed source** | FF Cloud (orchestration) | FF Cloud (orchestration + business logic) |
| **User isolation** | VM boundary (strong) | Application boundary (orchestration) + VM (execution) |
| **Workspace isolation** | Container/process within user VM | VM per workspace (strong) |
| **Resource cost/user** | ~500MB (VM + FF Server + 5 workspaces) | ~300MB (5 workspace VMs with FF Core, shared orchestration) |
| **Desktop parity** | Perfect (same FF Server) | Perfect (same FF Core library) |
| **Time to MVP** | 6-8 weeks | 4-5 weeks (extract library + build cloud) |
| **Team features** | Hard (query multiple VMs) | Easy (shared PostgreSQL) |
| **Scaling strategy** | Vertical (bigger host for VMs) | Horizontal (multiple FF Cloud instances) |
| **Failure blast radius** | Single user | All users (mitigated by horizontal scaling) |
| **Maintenance burden** | Higher (two full applications) | Medium (library + cloud service) |
| **Community value** | High (full FF is open) | Medium (core primitives open, cloud closed) |
| **Migration path** | Can't easily merge later | Can add desktop features to core lib |

## Why Approach #2

Given the constraint that **FF must stay open source** and **FF Cloud must be closed source**, Approach #2 with library extraction is the only viable path. Approach #1 would require keeping the full FF application open source, which conflicts with building a closed-source cloud business.

The library approach provides the best of both worlds:
- **Open source**: Core execution primitives (workspace, session, claude, ratchet)
- **Closed source**: Cloud infrastructure (multi-tenancy, billing, teams, VM orchestration)
- **Clear boundary**: Execution = open, Infrastructure = closed

## VM Startup Time Analysis

**Question: Won't per-workspace VMs mean that a workspace takes longer to start?**

**Short answer: Yes, but it's manageable with smart strategies (warm pools, fast runtimes, Phase 2 optimization).**

### Startup Time Breakdown

**Docker containers (Phase 1 MVP):**
- Cold start: ~1-2 seconds
- With image already pulled: ~500ms
- Breakdown:
  - Container creation: 200ms
  - Network setup: 100ms
  - Filesystem mount: 100ms
  - Process start (Claude CLI): 100-500ms

**Firecracker microVMs (Phase 2+ production):**
- Cold start: ~125-300ms (AWS Lambda uses this)
- Breakdown:
  - VM boot: 125ms
  - Init process: 50ms
  - Claude CLI start: 50-125ms

**For comparison, Desktop FF startup:**
- First workspace: ~2-3 seconds (spawn Claude CLI, load session)
- Additional workspaces: ~500ms each (reuse existing infrastructure)

### Mitigation Strategies

#### 1. Warm VM Pools (Phase 1)

Pre-provision VMs so they're ready when users need them:

```
┌──────────────────────────────────────┐
│         Warm Pool Manager            │
│  - Maintains 10-50 warm VMs          │
│  - Replenishes pool as VMs are used  │
│  - Pre-loads common images           │
└──────────────────────────────────────┘
         ↓                 ↓
    [Warm VM 1]       [Warm VM 2]  ...  [Warm VM N]
    (ready to go)     (ready to go)

User requests workspace → Grab warm VM from pool → Start Claude CLI (500ms)
```

**Benefits:**
- Workspace startup feels instant (~500ms instead of ~2s)
- Pool size adjusts based on demand (more during peak hours)
- Cost: ~10-20 idle VMs x $0.01/hour = ~$2-4/day

**Trade-off:** Small cost for idle VMs vs better UX

#### 2. Lazy VM Provisioning (Phase 1)

Start the workspace in "initializing" state immediately, provision VM in background:

```typescript
// User clicks "Send to Cloud"
const workspace = await db.workspace.create({
  status: 'INITIALIZING',  // Show spinner in UI
  // ...
});

// Respond immediately to user
res.json({ workspaceId: workspace.id, status: 'INITIALIZING' });

// Provision VM asynchronously
provisionWorkspaceVM(workspace.id).then(() => {
  // Update status, notify frontend via WebSocket
  workspace.status = 'READY';
  notifyClient(workspace.id, { status: 'READY' });
});
```

**User experience:**
- Click "Send to Cloud" -> immediate feedback ("Initializing...")
- 1-2 seconds later -> status changes to "Ready" (via WebSocket notification)
- User doesn't perceive this as "slow" because they got instant acknowledgment

#### 3. Phase 2: VM-per-User (eliminates per-workspace startup)

In Phase 2, move to **1 VM per user** with **multiple workspaces inside**:

```
┌──────────────────────────────────────┐
│         User's Personal VM           │
│  ┌────────────────────────────────┐  │
│  │ Claude CLI (Workspace 1)       │  │  <- Already running
│  ├────────────────────────────────┤  │
│  │ Claude CLI (Workspace 2)       │  │  <- Already running
│  ├────────────────────────────────┤  │
│  │ Claude CLI (Workspace 3)       │  │  <- Already running
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
       ↑
   User's VM stays alive while user is active
```

**Startup time:**
- First workspace: ~2s (cold start user VM)
- Subsequent workspaces: ~100ms (just spawn Claude CLI subprocess)
- Same as desktop experience!

**User VM lifecycle:**
- VM starts on first workspace creation
- VM stays alive while user is active (has any running workspaces)
- VM shuts down after 10 minutes of inactivity (no workspaces running)
- Next day: Cold start again (~2s), but user expects this

#### 4. Aggressive Caching (All phases)

Cache everything possible:

- **Docker images**: Pre-pull on hosts, store in registry
- **Git repos**: Shallow clones (`--depth 1`), reuse existing checkouts
- **Dependencies**: Cache `node_modules`, Python virtualenvs in shared volumes
- **Claude sessions**: Resume existing sessions instead of starting fresh

**Example:** User has worked on `repo/feature-auth` before
- New workspace on same repo: Reuse existing git checkout (just `git pull`)
- Saves: 5-10 seconds of `git clone` time
- Claude session resume: Instant (session exists on disk)

#### 5. Smart Pre-warming (Phase 3+)

Predict which workspaces users will start and pre-warm them:

- User opens FF Cloud dashboard -> pre-warm user's VM in background
- User views workspace in mobile app -> pre-warm that workspace's VM
- User has auto-fix enabled -> keep ratchet VM always warm

**ML-based prediction:**
- User usually starts 3 workspaces in the morning -> pre-warm at 8:50am
- User works on repo X 80% of the time -> keep that repo's VM warm

### Startup Time Comparison Table

| Scenario | Desktop FF | Cloud FF (Phase 1) | Cloud FF (Phase 2) |
|----------|------------|-------------------|-------------------|
| First workspace | 2-3s | 1-2s (warm pool) | 2-3s (cold start user VM) |
| Second workspace | 500ms | 1-2s (new VM) | 100ms (same VM) |
| Third workspace | 500ms | 1-2s (new VM) | 100ms (same VM) |
| Resume existing | Instant | 1-2s (cold VM) | Instant (VM alive) |
| After 10min idle | Instant | 1-2s (cold VM) | 2-3s (VM shutdown) |

**Key insight:** Phase 2 (VM-per-user) provides the best of both worlds:
- First workspace: Comparable to desktop (2-3s)
- Additional workspaces: *Faster* than desktop (100ms vs 500ms)
- Security: Still isolated from other users (separate VMs)

### Recommendation: Don't Over-Optimize Early

**Phase 1 MVP:**
- Use warm VM pools (10-20 VMs)
- Lazy provisioning with immediate feedback
- Acceptable UX: 1-2s startup per workspace
- Focus on getting core features working

**Phase 2 optimization:**
- Migrate to VM-per-user once MVP is validated
- Solves startup time AND reduces cost
- Users with 5 workspaces: 5 VMs -> 1 VM

**Phase 3+ if needed:**
- Smart pre-warming based on usage patterns
- Firecracker for even faster cold starts (125ms)
- Only optimize further if users complain about startup time

**Bottom line:** VM startup time is a non-issue with warm pools in Phase 1, and becomes *better than desktop* in Phase 2 with VM-per-user architecture.
