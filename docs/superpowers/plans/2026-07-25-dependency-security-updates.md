# Dependency Security Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the repository's open Dependabot alerts, refresh compatible direct dependencies, and publish a verified dependency-update pull request.

**Architecture:** Keep application code unchanged and remediate at the dependency-policy layer. Move pnpm's root-only settings into `pnpm-workspace.yaml`, where pnpm 10.28 reads them, update direct packages within compatible ranges, and pin vulnerable transitive packages to patched releases only where their parents have not yet moved.

**Tech Stack:** pnpm 10.28.1, npm registry audit data, GitHub Dependabot API, TypeScript, Vitest, Biome.

## Global Constraints

- Preserve the package engine declaration `^20.19 || ^22.12 || >=24.0`.
- Do not introduce unrelated application-code changes.
- Resolve all 13 open GitHub Dependabot alerts fetched on 2026-07-25.
- Prefer current patch/minor releases and avoid unrelated breaking-major upgrades.
- Keep any residual audit advisory only when its patched release violates the Node engine constraint and the affected feature is not used.

---

### Task 1: Restore pnpm dependency policy

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: pnpm 10.28.1 workspace configuration.
- Produces: effective `overrides`, build-dependency allowlists, and public hoist patterns for lockfile generation.

- [x] **Step 1: Confirm the configuration failure**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected before the change: pnpm warns that `pnpm.onlyBuiltDependencies` and `pnpm.overrides` in `package.json` are ignored.

- [x] **Step 2: Move root pnpm settings**

Remove the `pnpm` object from `package.json`. Add its `publicHoistPattern`, `onlyBuiltDependencies`, `ignoredBuiltDependencies`, and `overrides` keys at the root of `pnpm-workspace.yaml`, preserving every existing entry before changing versions.

- [x] **Step 3: Verify pnpm reads the settings**

Run:

```bash
pnpm config get overrides
pnpm install --lockfile-only
```

Expected: no ignored-configuration warning, and the lockfile's top-level override map matches `pnpm-workspace.yaml`.

### Task 2: Refresh direct and vulnerable transitive dependencies

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the effective workspace dependency policy from Task 1.
- Produces: a lockfile without the vulnerable versions identified by Dependabot and with direct packages refreshed inside supported compatibility bounds.

- [x] **Step 1: Update compatible direct dependencies**

Run:

```bash
pnpm update --recursive
```

Expected: direct dependencies advance only within their declared semver ranges.

- [x] **Step 2: Raise security-sensitive direct constraints**

Set the exact packages that are pinned or whose existing lower bounds need to advertise the fix:

```text
next = 16.2.11
react = ^19.2.8
react-dom = ^19.2.8
react-router = ^7.18.0
@prisma/adapter-better-sqlite3 = 7.9.0
@prisma/client = 7.9.0
prisma = 7.9.0
electron-builder = ^26.15.3
@electron/rebuild = ^4.2.0
postcss = ^8.5.23
wait-on = ^9.1.0
```

- [x] **Step 3: Raise vulnerable overrides**

Update or add these workspace overrides:

```text
@hono/node-server = 2.0.10
axios = 1.18.1
body-parser = 2.3.0
brace-expansion = 5.0.8
dompurify = 3.4.12
fast-uri = 3.1.4
find-my-way = 9.7.0
hono = 4.12.32
js-yaml = 4.3.0
postcss = 8.5.23
sharp = 0.35.0
shell-quote = 1.9.0
tar = 7.5.22
valibot = 1.4.2
```

Also update existing `next`, `@hono/node-server`, and other duplicated direct-package overrides to the same selected versions so the manifest and resolution policy cannot drift.

- [x] **Step 3a: Align Electron Builder's optional peer graph**

Declare a `packageExtensions` entry for `electron-builder@26.15.3` that supplies `electron-builder-squirrel-windows` 26.15.3. This prevents pnpm from retaining the vulnerable 26.4.0 peer graph without misclassifying the peer helper as a direct application dependency.

- [x] **Step 4: Regenerate and inspect the lockfile**

Run:

```bash
pnpm install
pnpm list --depth 20
```

Expected: the patched versions appear in the resolved graph and the vulnerable versions no longer appear on the alert paths.

### Task 3: Verify and publish

**Files:**
- Verify: `package.json`
- Verify: `pnpm-workspace.yaml`
- Verify: `pnpm-lock.yaml`
- Verify: `docs/superpowers/plans/2026-07-25-dependency-security-updates.md`

**Interfaces:**
- Consumes: the updated manifest and lockfile.
- Produces: a pushed task branch and draft GitHub pull request.

- [x] **Step 1: Verify security resolution**

Run:

```bash
pnpm audit --json
```

Expected: all actionable advisories are resolved. A React Router RSC-only advisory may remain because React Router 8.3.0 requires Node 22.22 while this project supports Node 20; verify the repository uses only SPA APIs and document that exception if present.

- [x] **Step 2: Run project guardrails**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check
pnpm build
pnpm install --frozen-lockfile
```

Expected: every command exits 0, the full Vitest suite reports zero failures, and pnpm emits no ignored-configuration warning.

- [x] **Step 3: Review and publish**

Run:

```bash
git diff --check
git status -sb
git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml docs/superpowers/plans/2026-07-25-dependency-security-updates.md
git add package.json pnpm-workspace.yaml pnpm-lock.yaml docs/superpowers/plans/2026-07-25-dependency-security-updates.md
git commit -m "Update dependencies and resolve security alerts"
git push -u origin "$(git branch --show-current)"
```

Create a draft pull request against `main` summarizing the Dependabot findings, dependency-policy migration, direct updates, any documented audit exception, and the exact validation results.
