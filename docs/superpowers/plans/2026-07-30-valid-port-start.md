# Valid Port Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject invalid starting ports immediately in the CLI and backend port finders so `ff serve --port 0 --dev` cannot wait on an unconnectable port.

**Architecture:** Keep the two existing port-finder boundaries and add identical integer/range validation before either begins probing. Preserve the current scan behavior for valid ports and use focused regression tests to prove invalid inputs never invoke `lsof`.

**Tech Stack:** TypeScript, Node.js networking APIs, Vitest, pnpm

## Global Constraints

- Valid starting ports are integers in the inclusive range `1..65_535`.
- Invalid input throws `Invalid start port <value>: expected an integer between 1 and 65535`.
- Invalid input must be rejected before any port probe.
- Existing behavior for valid start ports, exclusions, maximum attempts, and upper-bound scanning remains unchanged.

---

### Task 1: CLI Port Finder Validation

**Files:**
- Modify: `src/cli/runtime-utils.test.ts`
- Modify: `src/cli/runtime-utils.ts`

**Interfaces:**
- Consumes: `findAvailablePort(startPort: number, options?: FindAvailablePortOptions): Promise<number>`
- Produces: The same function signature with upfront integer/range validation.

- [ ] **Step 1: Write the failing CLI regression test**

Add this case inside the existing `describe('findAvailablePort')` block:

```typescript
it.each([0, -1, 65_536, 1.5])(
  'rejects invalid start port %s before probing',
  async (startPort) => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(findAvailablePort(startPort)).rejects.toThrow(
      `Invalid start port ${startPort}: expected an integer between 1 and 65535`
    );

    expect(mockExec).not.toHaveBeenCalled();
  }
);
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
pnpm vitest run src/cli/runtime-utils.test.ts
```

Expected: FAIL because the current helper can return invalid values such as `0` and does not produce the validation error.

- [ ] **Step 3: Implement minimal CLI validation**

Add `MIN_PORT` beside `MAX_PORT`, then validate before reading options or entering the scan:

```typescript
const MIN_PORT = 1;
const MAX_PORT = 65_535;

if (!Number.isInteger(startPort) || startPort < MIN_PORT || startPort > MAX_PORT) {
  throw new Error(
    `Invalid start port ${startPort}: expected an integer between ${MIN_PORT} and ${MAX_PORT}`
  );
}
```

- [ ] **Step 4: Run the CLI test and verify GREEN**

Run:

```bash
pnpm vitest run src/cli/runtime-utils.test.ts
```

Expected: 2 tests pass.

### Task 2: Backend Port Finder Validation

**Files:**
- Modify: `src/backend/services/port.service.test.ts`
- Modify: `src/backend/services/port.service.ts`

**Interfaces:**
- Consumes: `findAvailablePort(startPort: number, maxAttempts?: number): Promise<number>`
- Produces: The same function signature with validation matching the CLI helper.

- [ ] **Step 1: Write the failing backend regression test**

Add this case inside the backend `describe('findAvailablePort')` block:

```typescript
it.each([0, -1, 65_536, 1.5])(
  'should reject invalid start port %s before probing',
  async (startPort) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(findAvailablePort(startPort)).rejects.toThrow(
      `Invalid start port ${startPort}: expected an integer between 1 and 65535`
    );

    expect(mockExec).not.toHaveBeenCalled();
  }
);
```

- [ ] **Step 2: Run the backend test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/port.service.test.ts
```

Expected: FAIL because the current helper probes or returns invalid values and does not produce the validation error.

- [ ] **Step 3: Implement minimal backend validation**

Add `MIN_PORT` beside `MAX_PORT` and the same validation block at the start of the backend `findAvailablePort`.

- [ ] **Step 4: Run both focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/cli/runtime-utils.test.ts src/backend/services/port.service.test.ts
```

Expected: Both test files pass with no warnings.

- [ ] **Step 5: Commit the regression fix**

```bash
git add src/cli/runtime-utils.ts src/cli/runtime-utils.test.ts \
  src/backend/services/port.service.ts src/backend/services/port.service.test.ts
git commit -m "Reject invalid port finder starts (#2082)"
```

### Task 3: Full Verification and Publication

**Files:**
- Review: all changes relative to `origin/main`
- Create outside repository: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: committed port validation and regression tests.
- Produces: a verified GitHub pull request closing issue `#2082`.

- [ ] **Step 1: Run all required verification**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: exit code `0` for every command. Review and explicitly stage any formatter changes before the final commit.

- [ ] **Step 2: Review the complete change**

```bash
git diff origin/main
git status -sb
```

Expected: only the planning artifacts and four intended source/test files differ from `origin/main`; no debug output or unrelated changes are present.

- [ ] **Step 3: Commit any verification-only formatting changes**

If `pnpm check:fix` changed intended files:

```bash
git add docs/superpowers/specs/2026-07-30-valid-port-start-design.md \
  docs/superpowers/plans/2026-07-30-valid-port-start.md \
  src/cli/runtime-utils.ts src/cli/runtime-utils.test.ts \
  src/backend/services/port.service.ts src/backend/services/port.service.test.ts
git commit -m "Format port validation changes (#2082)"
```

If it made no changes, verify `git status --short` is empty.

- [ ] **Step 4: Push and create the pull request**

Push the existing issue branch with tracking, write the required summary, testing checklist, `Closes #2082`, and Factory Factory signature to `/tmp/pr-body.md`, then run:

```bash
git push -u origin HEAD
gh pr create --title "Fix #2082: Reject invalid port finder starts" --body-file /tmp/pr-body.md
gh pr view --web
```

Expected: `gh` reports the new pull request URL and successfully opens its web view.
