# Coverage Minimums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce aggregate backend coverage minimums of 82% lines, 82% statements, 84% functions, and 72% branches.

**Architecture:** Configure Vitest's native global coverage thresholds in the existing root test configuration. The current `pnpm test:coverage` command and CI coverage job will enforce the minimums without additional scripts or workflow steps.

**Tech Stack:** TypeScript, Vitest 4, V8 coverage, pnpm

## Global Constraints

- Lines must remain at or above 82%.
- Statements must remain at or above 82%.
- Functions must remain at or above 84%.
- Branches must remain at or above 72%.
- Keep the existing critical grouped and per-file coverage checks unchanged.
- This is a configuration-only change; validate it with the full coverage suite instead of a config unit test.

---

### Task 1: Configure and verify global coverage thresholds

**Files:**
- Modify: `vitest.config.ts`
- Test: `pnpm test:coverage`

**Interfaces:**
- Consumes: Vitest's `test.coverage.thresholds` configuration.
- Produces: A failing `pnpm test:coverage` command whenever aggregate coverage drops below any configured minimum.

- [ ] **Step 1: Add native thresholds**

Replace the obsolete disabled-threshold comments in `vitest.config.ts` with:

```ts
thresholds: {
  lines: 82,
  statements: 82,
  functions: 84,
  branches: 72,
},
```

- [ ] **Step 2: Run the full coverage suite**

Run:

```bash
pnpm test:coverage
```

Expected: exit code 0, no global coverage threshold errors, and all existing critical coverage checks pass.

- [ ] **Step 3: Run repository guardrails**

Run:

```bash
pnpm check
pnpm typecheck
```

Expected: both commands exit with code 0.

- [ ] **Step 4: Review and commit**

Run:

```bash
git diff --check
git diff
git status -sb
git add vitest.config.ts docs/superpowers/specs/2026-07-16-coverage-minimums-design.md docs/superpowers/plans/2026-07-16-coverage-minimums.md
git commit -m "Enforce coverage minimums"
```

Expected: the diff contains only the approved coverage configuration and its design/plan documentation.
