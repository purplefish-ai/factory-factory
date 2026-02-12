# Milestones

## v1.0 SRP Consolidation (Shipped: 2026-02-10)

**Phases completed:** 10 phases, 31 plans, 0 tasks

**Key accomplishments:**
- Consolidated 45+ flat services into 6 domain modules (session, workspace, github, ratchet, terminal, run-script) with barrel-file encapsulation
- Created orchestration layer with bridge interfaces for cross-domain coordination, eliminating direct service-to-service coupling
- Enforced architectural boundaries with 18 dependency-cruiser rules — zero violations across 682 modules
- Eliminated module-level mutable state (DOM-04) — static Maps and globals replaced with instance fields
- Rewired all imports to use domain barrel files, deleted shim files, cleaned infrastructure-only services directory
- Full backward compatibility validated: 1609 tests passing, production build succeeding, runtime smoke test confirmed

---


## v1.1 Project Snapshot Service (Shipped: 2026-02-12)

**Phases completed:** 8 phases (11-18), 11 plans
**Timeline:** 1 day (2026-02-11)
**Files changed:** 176 (+25,254 / -3,097)

**Key accomplishments:**
- In-memory WorkspaceSnapshotStore with versioned per-workspace entries, field-level timestamp merging, and derived state recomputation
- EventEmitter-based domain event emission across workspace, github, ratchet, run-script, and session domains — events emitted after successful mutations only
- Event collector orchestrator with 150ms per-workspace coalescing, wiring all 6 domain event types to snapshot store updates
- Safety-net reconciliation (60s cadence) with drift detection, git stats computation, and stale entry cleanup
- Project-scoped /snapshots WebSocket endpoint with full-snapshot-on-connect and per-workspace delta push
- Sidebar, kanban, and workspace list migrated from independent polling (2s/15s) to WebSocket-driven snapshots with 30-60s polling fallback

---

