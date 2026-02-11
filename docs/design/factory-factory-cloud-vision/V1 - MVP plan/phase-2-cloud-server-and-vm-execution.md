# Phase 2: FF Cloud Server + VM Execution

**Goal:** Stand up the cloud server and get workspaces executing in Docker containers. No auth or user management yet — this phase proves the execution model works.

## 2.1 New Private Repo

Create `factory-factory-cloud` (private repo, closed source):

```
factory-factory-cloud/
  src/
    server.ts                   # Express server
    services/
      vm.service.ts             # Docker container orchestration
      workspace.service.ts      # Workspace management (uses @factory-factory/core)
    db/
      schema.prisma             # PostgreSQL
  package.json
    dependencies:
      "@factory-factory/core": "^1.0.0"
```

## 2.2 PostgreSQL Schema

Schema mapping workspaces to VMs (single-user for now, multi-tenant later):

```
workspaces     — id, vm_id, status, location, github_issue_url, pr_url, ratchet state fields
vms            — id, workspace_id, container_id, status, created_at, last_health_check
```

Each VM also has its own SQLite (managed by FF Core inside the container) for workspace execution state.

## 2.3 Docker Container Orchestration

- **Container image:** FF Core + Claude CLI + Node.js runtime pre-installed
- **Provisioning:** 1 container per workspace, spin up on workspace creation
- **Lifecycle:** create, health check, terminate
- **Warm pool:** Pre-warmed containers for fast startup (~500ms target). Pool size configurable.
- **Resource limits:** CPU/memory caps per container

## 2.4 Desktop Integration

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

A workspace can be created in a cloud container, execute Claude sessions, and be sent to/pulled from cloud via the desktop app. Execution works end-to-end, but there's no real-time streaming to a web UI yet — results are visible when pulling back to desktop. Auth is hardcoded/API-key-only for internal testing.
