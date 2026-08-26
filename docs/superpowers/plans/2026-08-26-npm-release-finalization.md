# npm Release Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent feature-branch npm staging and create Git tags and GitHub releases only after the exact package version has passed npm's staged-publish 2FA approval.

**Architecture:** Keep verification and npm staging in the existing artifact handoff, but allow real manual staging only from `main`. Split manual releases into two dispatches: the first stages the package, and a later `finalize_release` dispatch verifies the version is public on npm before creating the tag and GitHub release.

**Tech Stack:** GitHub Actions, npm CLI 11.19, pnpm 10, TypeScript, Vitest, YAML, Zod.

**Spec:** [PR #2199 review and approved two-phase design](https://github.com/purplefish-ai/factory-factory/pull/2199)

## Global Constraints

- Use pnpm only for repository dependency installation and test commands; never use npm or yarn for package management.
- Keep npm trusted publishing tokenless and grant `id-token: write` only to the protected `stage` job.
- Allow dry runs from any branch, but allow real manual staging and finalization only from `refs/heads/main`.
- Require a second manual dispatch with `finalize_release: true` after npm 2FA approval.
- Verify `factory-factory@<package.json version>` is public before writing a Git tag or GitHub release.
- Pin every external GitHub Action to an immutable 40-character commit SHA.
- Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check` before pushing.

---

## File Structure

**Modify:**

- `src/backend/testing/npm-publish-workflow.test.ts`: semantic regression coverage for dispatch inputs, main-branch staging, finalize-only execution, and npm publication verification.
- `.github/workflows/npm-publish.yml`: approved two-phase release behavior.
- Pull request #2199 body: rollout instructions for the staging, 2FA approval, and finalization dispatch sequence.

### Task 1: Encode the approved release gates

**Files:**
- Test: `src/backend/testing/npm-publish-workflow.test.ts`

**Interfaces:**
- Consumes: the parsed `.github/workflows/npm-publish.yml` document.
- Produces: semantic assertions that reject feature-branch real staging, coupled staging/finalization, and finalization without a public npm version.

- [ ] **Step 1: Extend the workflow schema and add failing assertions**

Parse the `workflow_dispatch.inputs` map and assert that `finalize_release` is a boolean input defaulting to `false`. Require the `verify` job to skip finalize-only dispatches, require manual artifact upload and staging expressions to include `github.ref == 'refs/heads/main'` and `finalize_release != 'true'`, and require the finalize job to run independently only on a main-branch `finalize_release == 'true'` dispatch.

Require a `Verify package is published on npm` step before tag creation whose command reads the package version, queries `npm view`, rejects a mismatch, and writes the verified version to `GITHUB_OUTPUT`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm test src/backend/testing/npm-publish-workflow.test.ts
```

Expected: FAIL because `finalize_release` and the new job conditions and publication check do not exist.

### Task 2: Implement the two-phase workflow

**Files:**
- Modify: `.github/workflows/npm-publish.yml`

**Interfaces:**
- Consumes: manual `dry_run` and `finalize_release` boolean inputs plus release events.
- Produces: tokenless npm staging on release events or non-dry main-branch stage dispatches; GitHub release writes only after a separate main-branch finalization dispatch verifies npm publication.

- [ ] **Step 1: Add and apply the finalization input**

Add:

```yaml
finalize_release:
  description: "Finalize after approving the staged package on npm"
  required: false
  default: "false"
  type: boolean
```

Skip `verify` on finalization dispatches. Keep dry runs branch-independent. Restrict real manual artifact upload and `stage` execution to `refs/heads/main` with `finalize_release != 'true'`.

- [ ] **Step 2: Decouple and gate GitHub release writes**

Remove `needs: stage` from `finalize-release`. Gate the job on workflow dispatch, `refs/heads/main`, `dry_run != 'true'`, and `finalize_release == 'true'`. Replace `Compute release version` with `Verify package is published on npm`:

```bash
set -euo pipefail
VERSION=$(node -p "require('./package.json').version")
PUBLISHED_VERSION=$(npm view "factory-factory@$VERSION" version)
if [ "$PUBLISHED_VERSION" != "$VERSION" ]; then
  echo "factory-factory@$VERSION is not published on npm" >&2
  exit 1
fi
echo "version=$VERSION" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Run the focused test and confirm GREEN**

Run:

```bash
pnpm test src/backend/testing/npm-publish-workflow.test.ts
```

Expected: PASS.

### Task 3: Document, verify, and publish the review fix

**Files:**
- Modify: pull request #2199 body through a body file.

**Interfaces:**
- Produces: maintainer-facing rollout instructions and review replies tied to the verified commit.

- [ ] **Step 1: Update the PR rollout sequence**

Explain that maintainers first run the non-dry workflow on `main`, approve the staged package with npm 2FA, then run the workflow again on `main` with `finalize_release: true` to create the tag and GitHub release.

- [ ] **Step 2: Run the complete repository checks**

Run, in order:

```bash
pnpm check:fix
pnpm typecheck
pnpm test
pnpm check
```

Expected: every command exits zero.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/npm-publish.yml src/backend/testing/npm-publish-workflow.test.ts docs/superpowers/plans/2026-08-26-npm-release-finalization.md
git commit -m "Gate release finalization on npm approval"
git push
```

- [ ] **Step 4: Reply to and resolve both review threads**

Reply with the main-branch staging gate and the verified two-dispatch finalization behavior, including the passing checks, then resolve both threads.
