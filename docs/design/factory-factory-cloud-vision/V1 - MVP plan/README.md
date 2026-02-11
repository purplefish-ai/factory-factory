# V1 - Cloud MVP Plan

This document breaks down the work required to ship a Cloud MVP for Factory Factory. The MVP enables users to send workspaces to the cloud, interact with them via a web UI, and have ratchet (auto-fix) work seamlessly across desktop and cloud.

## Key Decisions

### 1 VM per user, not per workspace
Each user gets a single persistent VM. All their workspaces run inside it as Claude CLI subprocesses managed by FF Core — the same model as desktop, where one machine runs multiple workspaces. This is simpler, cheaper, and means credentials only need to be set up once.

### Terminal onboarding for GitHub and Anthropic auth
When a user's VM is first provisioned, they get terminal access and run `gh auth login` and Claude CLI auth themselves. FF Cloud never sees or stores third-party credentials — they live only inside the user's VM. This avoids building a GitHub App or Anthropic API key management system, and gives users the exact same auth flow they already know from desktop.

### FF Core stays open source, FF Cloud is closed source
The execution primitives (workspace management, session management, Claude CLI, ratchet, git operations) are extracted into `@factory-factory/core` and published to npm as open source. FF Cloud is a separate private repo that imports core as a dependency. The boundary is clear: open source = single-workspace execution, closed source = multi-tenant orchestration.

### Bridge interfaces as the core API contract
Domains don't import from each other directly. Instead, each domain declares bridge interfaces describing what it needs from other domains. Consumers (desktop, cloud) wire these bridges at startup. This means FF Cloud can wrap core's bridges with multi-tenant logic (quota checks, billing events) without modifying core.

### Auth before web frontend
Auth and billing (phase 3) are built before the web frontend (phase 4). This means the web app can build on real JWT authentication from day one, rather than shipping without auth and retrofitting it later.

### Docker first, Firecracker later
The MVP uses Docker containers for VM isolation. Migration to Firecracker microVMs for stronger security is a post-MVP concern. Docker is sufficient for the target audience (trusted users running their own code) and dramatically simpler to operate.

### Ratchet handoff via location field
Rather than coordinating between desktop and cloud ratchet services, we add a `location` field (`DESKTOP` | `CLOUD`) to workspaces. Each ratchet service simply filters by location. Changing the field is the handoff — no coordination protocol needed.

## Phases

| Phase | Name | What it delivers |
|-------|------|-----------------|
| [1](./phase-1-core-library-extraction.md) | Core Library Extraction | `@factory-factory/core` published to npm, desktop works via the library |
| [2](./phase-2-cloud-server-and-vm-execution.md) | FF Cloud Server + VM Execution | Per-user VMs running workspaces in Docker, terminal onboarding for gh/claude auth |
| [3](./phase-3-auth-and-billing.md) | Auth & Billing | User accounts, multi-tenant enforcement, Stripe billing |
| [4](./phase-4-websocket-relay-and-web-frontend.md) | WebSocket Relay + Web Frontend | Real-time streaming and a web UI for cloud workspaces |
| [5](./phase-5-ratchet-handoff.md) | Ratchet Handoff | Ratchet works across desktop/cloud |
