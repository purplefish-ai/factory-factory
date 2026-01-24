/**
 * Orchestrator MCP Tools
 *
 * NOTE: All orchestrator tools have been removed as they are now handled by
 * the reconciliation service (src/backend/services/reconciliation.service.ts).
 *
 * The reconciler handles:
 * - Crash detection (Phase 1)
 * - Supervisor creation for new top-level tasks (Phase 2)
 * - Worker creation and infrastructure (Phase 3)
 * - Agent state reconciliation and recovery (Phase 4)
 *
 * See docs/WORKFLOW.md and docs/RECONCILIATION_DESIGN.md for details.
 */

// ============================================================================
// Tool Registration
// ============================================================================

export function registerOrchestratorTools(): void {
  // No tools to register - all functionality moved to reconciler
}
