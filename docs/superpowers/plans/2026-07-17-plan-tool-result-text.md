# Plan Tool Result Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent metadata-only Codex plan results from rendering item IDs as plan text.

**Architecture:** Keep permissive shared plan parsing intact for its existing consumers. Add a renderer-local content guard that follows only explicit plan-bearing fields, then use the existing extractor for normalization.

**Tech Stack:** TypeScript, React renderer utilities, Vitest, Biome, pnpm

## Global Constraints

- Change only the plan tool-result renderer and its focused tests.
- Preserve direct text, fenced JSON, array content, and nested `plan.content[]` support.
- Return `null` for metadata-only, blank, or nested metadata-only plan envelopes.

---

### Task 1: Add plan-result regression coverage

**Files:**
- Test: `src/components/agent-activity/tool-renderers/tool-result-plan.test.ts`

**Interfaces:**
- Consumes: `extractPlanToolResult(content: ToolResultContentValue): ExtractedPlanToolResult | null`
- Produces: Regression expectations for metadata-only and invalid explicit fields.

- [ ] **Step 1: Add failing metadata-only tests**

```typescript
it('returns null for metadata-only plan payload strings', () => {
  const payload = JSON.stringify({
    type: 'plan',
    id: 'item_plan_approval',
    status: 'completed',
  });

  expect(extractPlanToolResult(payload)).toBeNull();
});

it('returns null for metadata-only plan payloads in text item arrays', () => {
  const payload = JSON.stringify({
    type: 'plan',
    id: 'item_plan_approval',
    status: 'completed',
  });

  expect(extractPlanToolResult([{ type: 'text', text: payload }])).toBeNull();
});

it('returns null when an explicit plan text field is blank', () => {
  const payload = JSON.stringify({
    type: 'plan',
    id: 'item_plan_approval',
    text: '   ',
  });

  expect(extractPlanToolResult(payload)).toBeNull();
});

it('returns null for nested metadata-only plan payloads', () => {
  const payload = JSON.stringify({
    type: 'plan',
    plan: { id: 'item_nested_plan', status: 'completed' },
  });

  expect(extractPlanToolResult(payload)).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run src/components/agent-activity/tool-renderers/tool-result-plan.test.ts`

Expected: the metadata-only and invalid explicit-field tests fail because IDs are returned as plan text.

### Task 2: Guard plan extraction at the renderer boundary

**Files:**
- Modify: `src/components/agent-activity/tool-renderers/tool-result-plan.ts`
- Test: `src/components/agent-activity/tool-renderers/tool-result-plan.test.ts`

**Interfaces:**
- Consumes: parsed `Record<string, unknown>` plan envelopes and `extractPlanText(value: unknown): string | null`
- Produces: renderer-local validation that only explicit plan content qualifies for specialized rendering.

- [ ] **Step 1: Add recursive explicit-content validation**

```typescript
const MAX_PLAN_SEARCH_DEPTH = 6;
const PLAN_TYPE = 'plan';
const PLAN_TEXT_KEYS = ['plan', 'markdown', 'text', 'content'] as const;

function hasPlanTextContent(value: unknown, depth = 0): boolean {
  if (depth > MAX_PLAN_SEARCH_DEPTH) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasPlanTextContent(item, depth + 1));
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;
  return PLAN_TEXT_KEYS.some(
    (key) => key in record && hasPlanTextContent(record[key], depth + 1)
  );
}
```

- [ ] **Step 2: Guard the shared extractor call**

```typescript
if (!hasPlanTextContent(planPayload)) {
  return null;
}

return extractPlanText(planPayload);
```

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/components/agent-activity/tool-renderers/tool-result-plan.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Commit the focused fix**

```bash
git add docs/superpowers src/components/agent-activity/tool-renderers/tool-result-plan.ts src/components/agent-activity/tool-renderers/tool-result-plan.test.ts
git commit -m "Fix plan result metadata rendering (#1921)"
```

### Task 3: Verify and publish

**Files:**
- Review: all changes relative to `origin/main`

**Interfaces:**
- Consumes: the completed renderer fix and tests.
- Produces: a clean, pushed issue branch and a pull request closing #1921.

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits successfully.

- [ ] **Step 2: Review and commit formatter-only changes if any**

Run: `git diff origin/main && git status --short`

Expected: only intended files differ and the working tree is clean after committing any formatter changes.

- [ ] **Step 3: Push and create the pull request**

Run: `git push -u origin HEAD`, then create the PR with title `Fix #1921: Prevent plan IDs rendering as text`, the required test checklist, `Closes #1921`, and the Factory Factory signature.

Expected: `gh pr view` returns the created pull request URL.
