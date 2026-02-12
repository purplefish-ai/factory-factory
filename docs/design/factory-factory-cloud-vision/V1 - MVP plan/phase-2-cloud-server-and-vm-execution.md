# Phase 2: FF Cloud Server + VM Execution

**Goal:** Stand up the cloud server and get workspaces executing in per-user VMs. No web frontend yet — this phase proves the execution model works, accessed only from the desktop app.

## 2.1 New Private Repo

Create `factory-factory-cloud` (private repo, closed source):

```
factory-factory-cloud/
  src/
    app/                          # Next.js app directory
      api/                        # REST API routes (for desktop app)
        workspaces/route.ts
        vms/route.ts
      trpc/                       # tRPC router (for web frontend)
        [trpc]/route.ts
    services/                     # Business logic (all API surfaces delegate here)
      vm.service.ts               # Docker container orchestration
      workspace.service.ts        # Workspace management (uses @factory-factory/core)
      relay.service.ts            # WebSocket relay between clients and VMs
    trpc/                         # tRPC router definitions
      workspace.router.ts
      vm.router.ts
    ws/                           # WebSocket handlers (raw ws, not tRPC)
      relay.handler.ts
      terminal.handler.ts
    db/
      schema.prisma               # PostgreSQL, multi-tenant
  package.json
    dependencies:
      "@factory-factory/core": "^1.0.0"
```

### Tech Stack

- **Next.js** — React frontend + API routes in one project
- **TypeScript** — same as FF Core and FF Desktop
- **PostgreSQL + Prisma** — multi-tenant data (users, workspaces, VMs, billing)
- **tRPC** — typed API for the web frontend
- **REST API routes** — for desktop app and external consumers
- **Raw WebSocket (`ws`)** — for real-time relay between clients and VMs
- **Auth.js (NextAuth)** — JWT, OAuth with GitHub, session management
- **Stripe** — subscriptions, metered billing
- **Docker SDK (`dockerode`)** — programmatic container management

### Service-Layer Architecture

All business logic lives in services. tRPC routers, REST API routes, and WebSocket handlers are thin wrappers that handle auth/validation and delegate to the same services:

```
Web Frontend  ──tRPC──►  tRPC Router  ──►  WorkspaceService.create()
Desktop App   ──REST──►  API Route    ──►  WorkspaceService.create()
Both          ──WS────►  WS Handler   ──►  RelayService.forward()
```

This means:
- No business logic duplication across API surfaces
- tRPC or REST routes can be added/removed without touching services
- Services are independently testable
- Same pattern FF Desktop already uses (tRPC routers call domain services)

## 2.2 PostgreSQL Schema

Schema mapping users to VMs and workspaces (single-user for now, multi-tenant later):

```
workspaces     — id, vm_id, status, location, github_issue_url, pr_url, ratchet state fields
vms            — id, container_id, status, created_at, last_health_check
```

Each VM has its own SQLite (managed by FF Core inside the container) for workspace execution state.

## 2.3 1 VM Per User

Each user gets a single persistent VM (Docker container). All their workspaces run inside it as Claude CLI subprocesses managed by FF Core.

- **Container image:** FF Core + Claude CLI + Node.js runtime + `gh` CLI pre-installed
- **Lifecycle:** create on first use, health check, suspend on idle, terminate on account deletion
- **Resource limits:** CPU/memory caps per container
- **Warm pool:** Pre-warmed containers for fast first-use startup (~500ms target)

Why 1 VM per user (not per workspace):
- **Credentials persist** — user auths to GitHub and Claude once, all workspaces use those credentials
- **Cost efficient** — 1 VM for 5-10 workspaces instead of 5-10 VMs
- **Simpler model** — same as desktop (one machine, multiple workspaces)

## 2.4 Onboarding: Terminal Auth Session

When a user's VM is first provisioned, FF Cloud launches an **onboarding session** that gives the user terminal access to their VM. The user authenticates to third-party services the same way they would on their local machine:

```
1. User clicks "Set up Cloud" in desktop app
2. FF Cloud provisions their VM
3. FF Cloud opens a terminal session inside the VM (using FF Core's terminal domain)
4. User runs `gh auth login` in the terminal → GitHub credentials stored in VM
5. User runs Claude CLI auth → Anthropic credentials stored in VM
6. Onboarding complete — VM is ready for workspaces
```

**Key properties:**
- FF Cloud never sees or stores GitHub/Anthropic credentials — they live only inside the user's VM
- Same auth flow the user already knows from desktop
- Credentials persist across workspaces (they're in the VM, not per-workspace)
- Re-auth is just opening another terminal session to the VM

## 2.5 Desktop Integration

**"Send to Cloud" flow:**
1. Desktop uploads workspace state (metadata, ratchet state, PR info) to FF Cloud API
2. FF Cloud restores workspace state in the user's VM via FF Core
3. VM clones the repo (using credentials already in the VM)
4. Desktop sets `location='CLOUD'` locally
5. Block if ratchet fixer session is active (user must wait or stop fixer)

**"Pull from Cloud" flow:**
1. Desktop requests workspace state from FF Cloud API
2. FF Cloud exports workspace state from the user's VM
3. Desktop restores state locally, sets `location='DESKTOP'`

## How to test manually

1. **Provision a VM:**
   ```bash
   curl -X POST http://localhost:3000/api/vms -H "Content-Type: application/json" \
     -d '{"userId": "test-user"}'
   ```
   Verify a Docker container is created and running (`docker ps` shows it).

2. **Terminal onboarding:**
   Open a terminal session to the VM (via desktop app "Set up Cloud" flow or API). Inside the terminal:
   ```bash
   gh auth login    # Complete GitHub auth
   gh auth status   # Verify: logged in
   claude --version # Verify Claude CLI is available
   ```

3. **Send a workspace to cloud:**
   In the desktop app, open a workspace with an active PR. Click "Send to Cloud". Verify:
   - Desktop shows `location: CLOUD`
   - FF Cloud API returns the workspace when queried
   - The VM has cloned the repo (check via terminal session)

4. **Execute a Claude session in the cloud:**
   Via the API, start a session on the cloud workspace:
   ```bash
   curl -X POST http://localhost:3000/api/workspaces/{id}/sessions \
     -H "Content-Type: application/json" -d '{"prompt": "What files are in this repo?"}'
   ```
   Verify Claude responds (check session status via API).

5. **Pull workspace back to desktop:**
   In the desktop app, click "Pull from Cloud". Verify:
   - Desktop shows `location: DESKTOP`
   - Workspace state (PR info, session history) is intact

6. **Health check and idle suspend:**
   Leave the VM idle for the configured timeout. Verify it suspends (container stopped but not removed). Trigger a new request — verify it resumes.

## Done when

A user can provision their cloud VM, authenticate via terminal, send a workspace to cloud, have it execute Claude sessions, and pull it back to desktop. Execution works end-to-end. Auth is hardcoded/API-key-only for internal testing (real user accounts come in phase 3).
