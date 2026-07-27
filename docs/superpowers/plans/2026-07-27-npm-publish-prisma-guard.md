# npm Publish Prisma Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the npm publish workflow accept the intentional runtime-only Prisma dependency placement while continuing to reject missing, ranged, or mismatched Prisma versions.

**Architecture:** Replace the untested JavaScript embedded in the GitHub Actions workflow with a focused Node.js command. Execute that real command from Vitest against temporary package manifests so the CI contract is covered independently of the repository's current manifest.

**Tech Stack:** Node.js ESM, TypeScript, Vitest, GitHub Actions YAML, pnpm

## Global Constraints

- Keep `prisma` in `dependencies`; the published package invokes Prisma at runtime.
- Require exact, matching versions for `@prisma/adapter-better-sqlite3`, `@prisma/client`, and `prisma`.
- Do not require or restore `devDependencies.prisma`.
- Keep the fix limited to the publish guard and its regression coverage.

---

### Task 1: Add the tested Prisma dependency checker

**Files:**
- Create: `scripts/check-prisma-versions.mjs`
- Create: `src/backend/testing/check-prisma-versions-script.test.ts`

**Interfaces:**
- Consumes: An optional package manifest path as `process.argv[2]`; defaults to `package.json` in the current working directory.
- Produces: Exit code `0` and a confirmation on stdout for aligned exact versions; exit code `1` with a dependency-specific error for invalid manifests.

- [ ] **Step 1: Write the failing regression tests**

Create `src/backend/testing/check-prisma-versions-script.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../../scripts/check-prisma-versions.mjs', import.meta.url)
);

describe('check-prisma-versions script', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  function run(dependencies: Record<string, string>) {
    tempRoot = mkdtempSync(join(tmpdir(), 'ff-prisma-versions-'));
    const manifestPath = join(tempRoot, 'package.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ dependencies, devDependencies: {} }, null, 2)}\n`,
      'utf8'
    );

    return spawnSync('node', [scriptPath, manifestPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const alignedDependencies = {
    '@prisma/adapter-better-sqlite3': '7.9.0',
    '@prisma/client': '7.9.0',
    prisma: '7.9.0',
  };

  it('accepts aligned runtime dependencies without devDependencies.prisma', () => {
    const result = run(alignedDependencies);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prisma dependencies are pinned to 7.9.0.');
  });

  it('rejects a missing runtime Prisma dependency', () => {
    const { prisma: _prisma, ...dependencies } = alignedDependencies;
    const result = run(dependencies);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prisma must be pinned exactly in dependencies, got undefined');
  });

  it('rejects a ranged Prisma version', () => {
    const result = run({ ...alignedDependencies, prisma: '^7.9.0' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prisma must be pinned exactly in dependencies, got ^7.9.0');
  });

  it('rejects mismatched exact Prisma versions', () => {
    const result = run({ ...alignedDependencies, prisma: '7.9.1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Prisma versions must match: @prisma/adapter-better-sqlite3=7.9.0, @prisma/client=7.9.0, prisma=7.9.1'
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run src/backend/testing/check-prisma-versions-script.test.ts
```

Expected: all four tests fail because `scripts/check-prisma-versions.mjs` does not exist.

- [ ] **Step 3: Add the minimal checker**

Create `scripts/check-prisma-versions.mjs`:

```js
#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] ?? 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const dependencies = manifest.dependencies ?? {};
const dependencyNames = [
  '@prisma/adapter-better-sqlite3',
  '@prisma/client',
  'prisma',
];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const versions = dependencyNames.map((name) => {
  const version = dependencies[name];
  if (typeof version !== 'string' || !exactVersion.test(version)) {
    throw new Error(
      `${name} must be pinned exactly in dependencies, got ${String(version)}`
    );
  }
  return version;
});

if (new Set(versions).size !== 1) {
  throw new Error(
    `Prisma versions must match: ${dependencyNames
      .map((name, index) => `${name}=${versions[index]}`)
      .join(', ')}`
  );
}

process.stdout.write(`Prisma dependencies are pinned to ${versions[0]}.\n`);
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/backend/testing/check-prisma-versions-script.test.ts
```

Expected: 1 test file and 4 tests pass.

- [ ] **Step 5: Run the checker against the repository manifest**

Run:

```bash
node scripts/check-prisma-versions.mjs
```

Expected stdout:

```text
Prisma dependencies are pinned to 7.9.0.
```

- [ ] **Step 6: Commit the checker and regression tests**

```bash
git add scripts/check-prisma-versions.mjs src/backend/testing/check-prisma-versions-script.test.ts
git commit -m "Test npm publish Prisma version guard"
```

### Task 2: Route npm publishing through the tested checker

**Files:**
- Modify: `.github/workflows/npm-publish.yml:46`

**Interfaces:**
- Consumes: `scripts/check-prisma-versions.mjs` from Task 1.
- Produces: The `Verify Prisma versions are pinned` workflow step with the same name and corrected manifest contract.

- [ ] **Step 1: Replace the stale inline workflow check**

Change the step to:

```yaml
      - name: Verify Prisma versions are pinned
        run: node scripts/check-prisma-versions.mjs
```

- [ ] **Step 2: Run focused formatting and regression checks**

Run:

```bash
pnpm exec biome check scripts/check-prisma-versions.mjs src/backend/testing/check-prisma-versions-script.test.ts
pnpm exec vitest run src/backend/testing/check-prisma-versions-script.test.ts
node scripts/check-prisma-versions.mjs
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 3: Commit the workflow integration**

```bash
git add .github/workflows/npm-publish.yml
git commit -m "Fix npm publish Prisma version guard"
```

- [ ] **Step 4: Run full repository verification**

Run:

```bash
pnpm test
pnpm check
pnpm typecheck
pnpm build
```

Expected: every command exits `0` with no test failures, type errors, dependency violations, or build failure.

- [ ] **Step 5: Reproduce the package portion of the publish workflow**

Run:

```bash
npm pack --dry-run
npm publish --dry-run
```

Expected: both commands exit `0`; no registry write occurs.

- [ ] **Step 6: Review the final diff and publish a draft PR**

Confirm only the spec, plan, checker, test, and workflow files differ from `origin/main`. Push the current branch and open a draft PR targeting `main` with the root cause and all verification commands in the body.
