# Foreign-Key Index Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unindexed Prisma relation scalar fields and add the one missing index for `Workspace.periodicTaskId`.

**Architecture:** A repository-local TypeScript command statically reads `prisma/schema.prisma`, extracts owning-side relation columns and covering indexes, and exits non-zero for uncovered relations or stale exemptions. The schema and SQLite migration add the missing index, and `package.json` makes the guard part of the standard check pipeline.

**Tech Stack:** TypeScript, `tsx`, Prisma schema language, SQLite migrations, pnpm.

## Global Constraints

- Check only owning-side `@relation(fields: [...])` scalar columns.
- Accept coverage by the leading columns of `@@index`, `@@unique`, `@@id`, `@unique`, or `@id`.
- Keep an exemption map that rejects unknown and stale entries.
- Do not change relation behavior or application query behavior.
- Do not commit changes unless the user explicitly requests a commit.

---

### Task 1: Add the Foreign-Key Index Guard

**Files:**
- Create: `scripts/check-fk-indexes.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `prisma/schema.prisma`
- Produces: `pnpm check:fk-indexes`, a command that exits `0` when every owning relation has a covering index and exits `1` with one diagnostic per violation otherwise.

- [ ] **Step 1: Create the checker**

Implement the established `iron-fillet` checker pattern in `scripts/check-fk-indexes.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEMPT: Record<string, string> = {};

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), '..');
const schemaPath = path.join(repositoryRoot, 'prisma/schema.prisma');

interface ModelInfo {
  name: string;
  indexes: string[][];
  relationFieldSets: string[][];
}

function parseColumnList(rawList: string): string[] {
  return rawList
    .split(',')
    .map((entry) => entry.trim().split(/[(:\s]/)[0] ?? '')
    .filter((name) => name.length > 0);
}

function parseModelLine(line: string, model: ModelInfo): void {
  const blockAttribute = line.match(/^@@(index|unique|id)\(\[([^\]]*)\]/);
  if (blockAttribute) {
    model.indexes.push(parseColumnList(blockAttribute[2] ?? ''));
    return;
  }

  const field = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+\S+(.*)$/);
  if (!field) {
    return;
  }

  const fieldName = field[1] ?? '';
  const attributes = field[2] ?? '';
  if (/@id\b/.test(attributes) || /@unique\b/.test(attributes)) {
    model.indexes.push([fieldName]);
  }

  const relationFields = attributes.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);
  if (relationFields) {
    model.relationFieldSets.push(parseColumnList(relationFields[1] ?? ''));
  }
}

function parseModels(schemaText: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const matches = schemaText.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([\s\S]*?)^\}/gm);

  for (const match of matches) {
    const model: ModelInfo = {
      name: match[1] ?? '',
      indexes: [],
      relationFieldSets: [],
    };
    for (const rawLine of (match[2] ?? '').split('\n')) {
      const line = (rawLine.split('//')[0] ?? '').trim();
      if (line.length > 0) {
        parseModelLine(line, model);
      }
    }
    models.push(model);
  }

  return models;
}

function isCovered(relationColumns: string[], indexes: string[][]): boolean {
  return indexes.some((indexColumns) => {
    if (indexColumns.length < relationColumns.length) {
      return false;
    }
    const leadingColumns = new Set(indexColumns.slice(0, relationColumns.length));
    return relationColumns.every((column) => leadingColumns.has(column));
  });
}
```

Complete the checker with:

```ts
function checkModel(model: ModelInfo, errors: string[], seenExemptions: Set<string>): void {
  for (const relationColumns of model.relationFieldSets) {
    const key = `${model.name}.${relationColumns.join('+')}`;
    const covered = isCovered(relationColumns, model.indexes);

    if (Object.hasOwn(EXEMPT, key)) {
      seenExemptions.add(key);
      if (covered) {
        errors.push(
          `Stale exemption: "${key}" is exempt but now has a covering index. Remove it from EXEMPT in scripts/check-fk-indexes.ts.`
        );
      }
      continue;
    }

    if (!covered) {
      errors.push(
        `Model "${model.name}" relation on [${relationColumns.join(', ')}] has no covering index. ` +
          `Add @@index([${relationColumns.join(', ')}]) (or exempt it with a reason in scripts/check-fk-indexes.ts).`
      );
    }
  }
}

function main(): void {
  const models = parseModels(readFileSync(schemaPath, 'utf8'));
  const errors: string[] = [];
  const seenExemptions = new Set<string>();

  for (const model of models) {
    checkModel(model, errors, seenExemptions);
  }

  for (const key of Object.keys(EXEMPT)) {
    if (!seenExemptions.has(key)) {
      errors.push(
        `Unknown exemption: "${key}" does not match any relation in prisma/schema.prisma. Remove it from EXEMPT.`
      );
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      ['Foreign key index check failed:', ...errors.map((error) => `- ${error}`), ''].join('\n')
    );
    process.exit(1);
  }

  process.stdout.write('Foreign key index check passed.\n');
}

main();
```

- [ ] **Step 2: Expose the command**

Add this script to `package.json`:

```json
"check:fk-indexes": "tsx scripts/check-fk-indexes.ts"
```

Do not add it to the aggregate `check` command yet; the red test needs to isolate the new guard.

- [ ] **Step 3: Run the checker and verify RED**

Run:

```bash
pnpm check:fk-indexes
```

Expected: exit `1` with exactly one uncovered relation:

```text
Model "Workspace" relation on [periodicTaskId] has no covering index.
```

If any other relation is reported, stop and reconcile the checker with the schema before changing indexes.

### Task 2: Add the Missing Workspace Index

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260728000000_add_workspace_periodic_task_id_index/migration.sql`
- Regenerate: `prisma/generated/internal/class.ts`

**Interfaces:**
- Consumes: the failing `pnpm check:fk-indexes` guard from Task 1.
- Produces: a schema and migration where `Workspace.periodicTaskId` has the physical SQLite index `Workspace_periodicTaskId_idx`.

- [ ] **Step 1: Add the schema index**

In `Workspace`, keep the single-column foreign-key indexes together:

```prisma
@@index([projectId])
@@index([status])
@@index([periodicTaskId])
@@index([parentWorkspaceId])
```

- [ ] **Step 2: Add the SQLite migration**

Create `prisma/migrations/20260728000000_add_workspace_periodic_task_id_index/migration.sql`:

```sql
-- CreateIndex
CREATE INDEX "Workspace_periodicTaskId_idx" ON "Workspace"("periodicTaskId");
```

- [ ] **Step 3: Regenerate the committed Prisma client**

Run:

```bash
pnpm db:generate
```

Expected: Prisma Client 7.9.0 regenerates successfully, with the schema snapshot
in `prisma/generated/internal/class.ts` reflecting the new index.

- [ ] **Step 4: Run the checker and verify GREEN**

Run:

```bash
pnpm check:fk-indexes
```

Expected:

```text
Foreign key index check passed.
```

- [ ] **Step 5: Verify schema/migration agreement**

Run the same migration drift command used by CI:

```bash
pnpm exec prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-migrations prisma/migrations \
  --exit-code
```

Expected: exit `0` with no schema drift.

### Task 3: Integrate and Verify the Guardrail

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: the passing `pnpm check:fk-indexes` command from Task 2.
- Produces: a standard `pnpm check` pipeline that enforces foreign-key index coverage.

- [ ] **Step 1: Wire the guard into `pnpm check`**

Change the aggregate command to:

```json
"check": "biome check . && pnpm check:env && pnpm check:ownership && pnpm check:fk-indexes && pnpm deps:check && pnpm check:codex-schema"
```

- [ ] **Step 2: Apply repository formatting**

Run:

```bash
pnpm check:fix
```

Review the resulting diff and keep only formatting changes in the files in this plan.

- [ ] **Step 3: Run focused verification**

Run:

```bash
pnpm check:fk-indexes
pnpm check:prisma-schema
pnpm typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 4: Run the standard repository check**

Run:

```bash
pnpm check
```

Expected: exit `0`, including `Foreign key index check passed.`

- [ ] **Step 5: Inspect the final change set**

Run:

```bash
git diff --check
git status --short
git diff -- scripts/check-fk-indexes.ts package.json prisma/schema.prisma prisma/generated/internal/class.ts prisma/migrations/20260728000000_add_workspace_periodic_task_id_index/migration.sql docs/superpowers/specs/2026-07-28-foreign-key-index-coverage-design.md docs/superpowers/plans/2026-07-28-foreign-key-index-coverage.md
```

Expected: no whitespace errors and no unrelated files modified.
