# Update Claude ACP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Factory Factory's bundled Claude ACP runtime so dynamic model discovery exposes Opus 5 instead of stale Opus 4.8 metadata.

**Architecture:** Keep the existing ephemeral ACP catalog-discovery flow unchanged. Update the ACP package and lockfile so both catalog discovery and live Claude sessions use a newer bundled Claude Agent SDK, then verify the real ACP boundary reports Opus 5.

**Tech Stack:** pnpm, TypeScript, Vitest, Agent Client Protocol, Claude Agent SDK

## Global Constraints

- Preserve ACP-driven dynamic model discovery; do not hard-code model names.
- Preserve raw model option values while allowing descriptions to drive display labels.
- Limit production changes to dependency metadata and compatibility fixes required by the update.

---

### Task 1: Update and verify Claude ACP

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts`
- Test: `src/backend/services/session/service/acp/acp-session-negotiation.integration.test.ts`

**Interfaces:**
- Consumes: `@agentclientprotocol/claude-agent-acp`'s `claude-agent-acp` binary and `NewSessionMeta` type.
- Produces: The unchanged `fetchClaudeModelCatalogFromAcp(): Promise<ClaudeModelCatalogEntry[]>` boundary backed by current Claude model metadata.

- [ ] **Step 1: Record the failing real-boundary reproduction**

Run the existing catalog loader against the currently locked dependency:

```bash
pnpm exec tsx -e "import { fetchClaudeModelCatalogFromAcp } from './src/backend/services/session/service/acp/claude-model-catalog-loader.ts'; void fetchClaudeModelCatalogFromAcp().then((catalog) => console.log(JSON.stringify(catalog, null, 2)));"
```

Expected before the update: the `opus[1m]` entry is labeled `Opus 4.8 (1M)`.

- [ ] **Step 2: Update the ACP dependency**

Run:

```bash
pnpm update @agentclientprotocol/claude-agent-acp@0.66.0
```

Expected: `package.json` and `pnpm-lock.yaml` resolve ACP `0.66.0` and its newer Claude Agent SDK.

- [ ] **Step 3: Verify the focused automated tests**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts src/backend/services/session/service/acp/acp-session-negotiation.integration.test.ts
```

Expected: both test files pass without changing the public catalog interface.

- [ ] **Step 4: Verify the real ACP catalog**

Run the Step 1 command again.

Expected after the update: the `opus[1m]` entry is labeled `Opus 5 (1M)`.

- [ ] **Step 5: Run repository guardrails**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check
pnpm check:fix
```

Expected: every command exits successfully and formatting produces no unintended changes.

- [ ] **Step 6: Commit and publish**

```bash
git add package.json pnpm-lock.yaml docs/superpowers/plans/2026-08-10-update-claude-acp.md
git commit -m "Update Claude ACP for Opus 5"
git push -u origin "$(git branch --show-current)"
```

Open a draft PR describing the stale bundled Claude Code root cause and the verification commands.
