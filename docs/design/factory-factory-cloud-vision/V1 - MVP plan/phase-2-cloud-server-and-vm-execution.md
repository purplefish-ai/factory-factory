# Phase 2: FF Cloud Server + VM Execution

**Goal:** Stand up the cloud server and get workspaces executing in Docker containers.

## 2.1 New Private Repo

Create `factory-factory-cloud` (private repo, closed source):

```
factory-factory-cloud/
  src/
    server.ts                   # Express server
    services/
      auth.service.ts           # JWT, accounts, API keys
      user.service.ts           # User management
      vm.service.ts             # Docker container orchestration
      workspace.service.ts      # Multi-tenant workspace management (uses @factory-factory/core)
    db/
      schema.prisma             # PostgreSQL, multi-tenant
  package.json
    dependencies:
      "@factory-factory/core": "^1.0.0"
```

## 2.2 Auth & User Management

- JWT-based authentication
- User accounts (email/password, OAuth with GitHub)
- API keys for programmatic access
- Session management (refresh tokens)

## 2.3 PostgreSQL Schema

Multi-tenant schema mapping users to workspaces and VMs:

```
users          — id, email, name, plan, created_at
workspaces     — id, user_id, vm_id, status, location, github_issue_url, pr_url, ratchet state fields
vms            — id, user_id, workspace_id, container_id, status, created_at, last_health_check
```

Each VM also has its own SQLite (managed by FF Core inside the container) for workspace execution state.

## 2.4 Docker Container Orchestration

- **Container image:** FF Core + Claude CLI + Node.js runtime pre-installed
- **Provisioning:** 1 container per workspace, spin up on workspace creation
- **Lifecycle:** create, health check, terminate
- **Warm pool:** Pre-warmed containers for fast startup (~500ms target). Pool size configurable.
- **Resource limits:** CPU/memory caps per container

## 2.5 Desktop Integration

**"Send to Cloud" flow:**
1. Desktop uploads workspace state (metadata, ratchet state, PR info) to FF Cloud API
2. FF Cloud provisions a container, clones the repo, restores workspace state via FF Core
3. Desktop sets `location='CLOUD'` locally
4. Block if ratchet fixer session is active (user must wait or stop fixer)

**"Pull from Cloud" flow:**
1. Desktop requests workspace state from FF Cloud API
2. FF Cloud exports workspace state from container
3. Desktop restores state locally, sets `location='DESKTOP'`
4. FF Cloud terminates the container

## Done when

A workspace can be created in a cloud container, execute Claude sessions, and be sent to/pulled from cloud via the desktop app. Execution works end-to-end, but there's no real-time streaming to a web UI yet — results are visible when pulling back to desktop.
