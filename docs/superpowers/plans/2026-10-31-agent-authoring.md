# Conversational Agent Creation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this
> approved design inline, task by task.

**Goal:** Workspace agents propose editable agent configurations in chat; users
create the saved agent with one button.

**Architecture:** Persist revisioned proposals in the agent-definition capsule.
Expose discovery/proposal MCP tools and trusted local tRPC procedures. Render
proposal references directly in chat, outside collapsed activity details.

**Tech Stack:** TypeScript, Zod, Prisma/SQLite, tRPC, React, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-authoring-design.md`.

## Global constraints

- Use existing schemas, capsule ownership, encryption, and workspace context.
- One creation action: **Create agent**. No live event dispatch in this slice.
- Never expose credentials; validate all JSON and provider responses with Zod.

## Review focus

- Duplicate clicks or retries must produce one definition, including
  concurrency.
- Old widgets must not accept stale revisions or overwrite newer proposals.
- Source IDs must match the selected provider connection and accessible catalog.
- The card must remain visible when ordinary tool activity is collapsed.
- Provider failures and missing configuration must surface actionable errors.

## Tasks

1. Add shared proposal contracts and AgentProposal persistence. Write failing
   integration tests for workspace scoping, revisions, atomic/idempotent create,
   provider checks, and preservation of user edits. Implement the accessor and
   service, migration, generated client, and registry ownership; rerun tests.
2. Add source discovery and workspace-bound propose/get tools using the existing
   MCP transport. Test the real subprocess HTTP contract and trusted-local API.
   Resolve Slack channels and the project's GitHub repository server-side.
3. Add the editable proposal card and chat result parser. Test edits, errors,
   creation, replay, and visibility outside collapsed groups. Add Storybook
   states.
4. Add authoring evaluation fixtures for feedback, packet unlock, and labeled
   issues, with follow-up edits and unresolved resources. Document the
   distinction between contract tests and live model evaluation.
5. Run check:fix, typecheck, full tests, integration tests, check, build, and
   Storybook/browser verification. Inspect the diff and request focused review.
