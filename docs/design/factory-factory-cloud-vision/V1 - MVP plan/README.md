# V1 - Cloud MVP Plan

This document breaks down the work required to ship a Cloud MVP for Factory Factory. The MVP enables users to send workspaces to the cloud, interact with them via a web UI, and have ratchet (auto-fix) work seamlessly across desktop and cloud.

## Phases

| Phase | Name | What it delivers |
|-------|------|-----------------|
| [1](./phase-1-core-library-extraction.md) | Core Library Extraction | `@factory-factory/core` published to npm, desktop works via the library |
| [2](./phase-2-cloud-server-and-vm-execution.md) | FF Cloud Server + VM Execution | Cloud server running workspaces in Docker containers |
| [3](./phase-3-websocket-relay-and-web-frontend.md) | WebSocket Relay + Web Frontend | Real-time streaming and a web UI for cloud workspaces |
| [4](./phase-4-ratchet-handoff.md) | Ratchet Handoff | Ratchet works across desktop/cloud |
| [5](./phase-5-auth-and-billing.md) | Auth & Billing | User accounts, multi-tenant enforcement, Stripe billing |
