# File-Length Ratchet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a 1,000-line ceiling for new handwritten JavaScript and TypeScript files while preventing every existing oversized file from growing.

**Architecture:** A typed script discovers tracked and unignored-untracked source files through Git, evaluates their physical line counts against an exact JSON baseline, and either reports drift or applies downward-only baseline updates. Policy logic remains independent of repository discovery and disk writes so Vitest can exercise it with deterministic inputs and temporary files.

**Tech Stack:** Node.js 22+, TypeScript 5.9, `tsx`, Vitest 4, Zod 4, pnpm 10.

## Global Constraints

- Use pnpm only; never use npm or yarn.
- The limit is exactly 1,000 physical lines; comments and blank lines count.
- Scan handwritten JavaScript and TypeScript under `src/`, `electron/`, and `scripts/`, including tests, stories, and fixtures.
- Exclude `prisma/generated/**`, dependencies, output directories, assets, documentation, lockfiles, and unsupported extensions.
- Existing oversized files use exact baseline counts and may shrink but never grow.
- Baseline updates must refuse all writes if any file grew or any new file exceeds 1,000 lines.
- Follow the approved design in `docs/superpowers/specs/2026-08-11-file-length-ratchet-design.md`.

---

## File Structure

- Create `scripts/check-file-length.ts`: policy types and functions, Git discovery, baseline I/O, diagnostics, and CLI entry point.
- Create `scripts/check-file-length.test.ts`: unit and CLI-level tests using temporary directories.
- Create `scripts/file-length-baseline.json`: sorted exact counts for current handwritten offenders.
- Modify `vitest.config.ts`: include script tests.
- Modify `tsconfig.json`: typecheck TypeScript under `scripts/`.
- Modify `package.json`: add check/update commands and wire the read-only check into `pnpm check`.
- Modify `AGENTS.md`: document the new everyday command and one-way baseline behavior.

### Task 1: Implement line counting and policy evaluation

**Files:**
- Create: `scripts/check-file-length.ts`
- Create: `scripts/check-file-length.test.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `countPhysicalLines(content: string): number`
- Produces: `isFileLengthCandidate(relativePath: string): boolean`
- Produces: `evaluateFileLengths(files: readonly FileLength[], baseline: FileLengthBaseline, maxLines?: number): FileLengthEvaluation`
- Produces: `FileLength`, `FileLengthBaseline`, `FileLengthViolation`, and `FileLengthEvaluation` exported types.

- [ ] **Step 1: Make script tests discoverable and typechecked**

Add `scripts/**/*.test.ts` to the Vitest `include` list and `scripts/**/*.ts` to the root TypeScript `include` list. Do not broaden production build inputs in `tsconfig.backend.json`.

- [ ] **Step 2: Write failing line-count and candidate-filter tests**

Create `scripts/check-file-length.test.ts` with focused cases equivalent to:

```ts
import { describe, expect, test } from 'vitest';
import { countPhysicalLines, isFileLengthCandidate } from './check-file-length';

describe('countPhysicalLines', () => {
  test.each([
    ['a\n', 1],
    ['a\r\n', 1],
    ['a\nb', 2],
    ['a\r\nb\r\n', 2],
    ['', 0],
  ])('counts physical lines without a phantom final line', (content, expected) => {
    expect(countPhysicalLines(content)).toBe(expected);
  });
});

describe('isFileLengthCandidate', () => {
  test.each(['src/a.ts', 'src/a.test.tsx', 'electron/main.mts', 'scripts/check.mjs'])(
    'includes %s',
    (file) => expect(isFileLengthCandidate(file)).toBe(true)
  );

  test.each(['prisma/generated/a.ts', 'docs/a.ts', 'src/a.json', 'dist/a.ts'])(
    'excludes %s',
    (file) => expect(isFileLengthCandidate(file)).toBe(false)
  );
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: FAIL because `scripts/check-file-length.ts` and its exports do not exist.

- [ ] **Step 4: Implement minimal line counting and candidate filtering**

Implement extension and root allowlists with POSIX-normalized repository paths. Count `\r\n`, `\n`, and lone `\r` as one terminator, count a final unterminated line, and do not count an empty file or a phantom line after a final terminator.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: PASS for line-count and filtering cases.

- [ ] **Step 6: Write failing policy-evaluation tests**

Add cases constructing `FileLength[]` values directly. Assert structured violation objects rather than matching formatted console strings:

```ts
expect(evaluateFileLengths([{ path: 'src/new.ts', lines: 1001 }], {})).toMatchObject({
  violations: [{ kind: 'new-oversized', path: 'src/new.ts', currentLines: 1001 }],
});

expect(
  evaluateFileLengths([{ path: 'src/legacy.ts', lines: 1201 }], {
    'src/legacy.ts': 1200,
  })
).toMatchObject({
  violations: [{ kind: 'grew', path: 'src/legacy.ts', currentLines: 1201, baselineLines: 1200 }],
});
```

Cover exactly 1,000 passing, an exact oversized baseline passing, shrinkage producing `baseline-stale`, reaching 1,000 producing `baseline-stale`, a missing baseline path producing `baseline-missing`, and path-sorted violations.

- [ ] **Step 7: Run the focused test and verify RED**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: FAIL because policy types and `evaluateFileLengths` are not implemented.

- [ ] **Step 8: Implement minimal policy evaluation**

Use a discriminated union for violation kinds:

```ts
export type FileLengthViolation =
  | { kind: 'new-oversized'; path: string; currentLines: number; maxLines: number }
  | { kind: 'grew'; path: string; currentLines: number; baselineLines: number }
  | { kind: 'baseline-stale'; path: string; currentLines: number; baselineLines: number }
  | { kind: 'baseline-missing'; path: string; baselineLines: number };
```

Return both sorted violations and the sorted current oversized entries needed by the update task. Reject invalid baseline values at the boundary rather than inside policy evaluation.

- [ ] **Step 9: Run focused tests and typecheck**

Run: `pnpm test scripts/check-file-length.test.ts && pnpm typecheck`

Expected: both commands exit 0.

- [ ] **Step 10: Commit Task 1**

```bash
git add scripts/check-file-length.ts scripts/check-file-length.test.ts vitest.config.ts tsconfig.json
git commit -m "Add file length policy checks"
```

### Task 2: Add repository discovery, diagnostics, and downward-only updates

**Files:**
- Modify: `scripts/check-file-length.ts`
- Modify: `scripts/check-file-length.test.ts`

**Interfaces:**
- Consumes: Task 1 policy functions and types.
- Produces: `discoverCandidatePaths(repositoryRoot: string): string[]`
- Produces: `readFileLengths(repositoryRoot: string, paths: readonly string[]): FileLength[]`
- Produces: `planBaselineUpdate(evaluation: FileLengthEvaluation): BaselineUpdatePlan`
- Produces: `formatFileLengthViolations(violations: readonly FileLengthViolation[]): string`
- Produces: `runFileLengthCli(options?: FileLengthCliOptions): number`

- [ ] **Step 1: Write failing update-policy tests**

Add cases proving that update planning:

- lowers a shrinking oversized entry;
- removes entries at or below 1,000 and missing entries;
- produces path-sorted JSON data;
- refuses a `grew` violation;
- refuses a `new-oversized` violation; and
- performs no write when any refusal exists.

Represent the result explicitly:

```ts
type BaselineUpdatePlan =
  | { ok: true; baseline: FileLengthBaseline }
  | { ok: false; blockingViolations: FileLengthViolation[] };
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: FAIL because `planBaselineUpdate` is missing.

- [ ] **Step 3: Implement update planning and deterministic serialization**

Derive the proposed baseline from `evaluation.currentOversized`. Treat only `new-oversized` and `grew` as update blockers. Serialize with two-space indentation, sorted keys, and a final newline.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing discovery and CLI-level tests**

Use `mkdtemp`, real files, and a temporary Git repository. Configure a local test identity, create files under allowed and excluded roots, and verify discovery includes cached plus unignored-untracked candidates. Add a CLI-level test that supplies a temporary repository root and baseline path, invokes the exported CLI runner, and captures injected stdout/stderr callbacks to assert exit code and diagnostics.

Also test malformed baseline JSON and schema-invalid baseline values such as `0`, `1000`, fractional values, and unsafe paths.

- [ ] **Step 6: Run the focused test and verify RED**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: FAIL because discovery, validated baseline I/O, diagnostics, and CLI orchestration are missing.

- [ ] **Step 7: Implement discovery and validated baseline I/O**

Use `execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repositoryRoot })` so filenames never pass through a shell. Split NUL-delimited output, normalize to POSIX paths, filter candidates, and sort.

Parse the baseline as unknown and validate it with Zod as a record whose keys are safe repository-relative candidate paths and whose values are integers greater than 1,000. Do not cast `JSON.parse` output.

For update mode, write the complete serialized baseline to a sibling temporary file and rename it over the target only after policy evaluation finds no blockers. Clean up the temporary file on a failed rename without broad or recursive deletion.

- [ ] **Step 8: Implement diagnostics and the CLI boundary**

Support only an optional `--update` argument. Normal mode exits 1 for any violation. Update mode exits 1 only for growth, new oversized files, discovery errors, or invalid baseline data; otherwise it atomically writes downward changes. Unknown arguments exit 1 with usage text.

Guard execution with an ESM entry-point comparison so importing the module in tests does not run the CLI.

- [ ] **Step 9: Run focused tests and typecheck**

Run: `pnpm test scripts/check-file-length.test.ts && pnpm typecheck`

Expected: both commands exit 0.

- [ ] **Step 10: Commit Task 2**

```bash
git add scripts/check-file-length.ts scripts/check-file-length.test.ts
git commit -m "Add file length ratchet updates"
```

### Task 3: Seed the baseline and wire repository guardrails

**Files:**
- Create: `scripts/file-length-baseline.json`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Test: `scripts/check-file-length.test.ts`

**Interfaces:**
- Consumes: Task 2 CLI behavior.
- Produces: `pnpm check:file-length` and `pnpm check:file-length:update` repository commands.

- [ ] **Step 1: Add a failing package-wiring test**

Add a test that parses `package.json` with a Zod schema and asserts:

```ts
expect(scripts['check:file-length']).toBe('tsx scripts/check-file-length.ts');
expect(scripts['check:file-length:update']).toBe('tsx scripts/check-file-length.ts --update');
expect(scripts.check).toContain('pnpm check:file-length');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test scripts/check-file-length.test.ts`

Expected: FAIL because the package scripts are absent.

- [ ] **Step 3: Add package scripts and check-chain integration**

Add the two commands above and place `pnpm check:file-length` immediately after `biome check .` in the existing `check` chain.

- [ ] **Step 4: Seed the exact initial baseline**

Generate the candidate inventory with the checker logic, review every entry, and create `scripts/file-length-baseline.json` containing all current handwritten files above 1,000 lines. Confirm it includes production, tooling, test, story, and fixture files but no generated or unsupported files. Keep keys alphabetically sorted.

- [ ] **Step 5: Document the command and policy**

Add `File length check | pnpm check:file-length` to the `AGENTS.md` everyday-command table. Add a concise guardrail note explaining that oversized legacy files have exact ceilings and that intentional reductions require `pnpm check:file-length:update`; the update command never blesses growth.

- [ ] **Step 6: Run focused tests and direct CLI checks**

Run:

```bash
pnpm test scripts/check-file-length.test.ts
pnpm check:file-length
pnpm check:file-length:update
git diff --exit-code scripts/file-length-baseline.json
```

Expected: all commands exit 0, and update mode leaves an already-current baseline unchanged.

- [ ] **Step 7: Run required repository verification**

Run in order:

```bash
pnpm check:fix
pnpm typecheck
pnpm test
pnpm check
```

Expected: all commands exit 0. Re-run `pnpm check:file-length` after `check:fix` in case formatting changed any candidate count.

- [ ] **Step 8: Review final scope and diff**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD
git diff HEAD -- scripts/check-file-length.ts scripts/check-file-length.test.ts scripts/file-length-baseline.json package.json vitest.config.ts tsconfig.json AGENTS.md
```

Verify that no generated files, unrelated source files, or inline Biome suppressions changed.

- [ ] **Step 9: Commit Task 3**

```bash
git add scripts/file-length-baseline.json package.json AGENTS.md scripts/check-file-length.test.ts
git commit -m "Enforce file length ratchet"
```
