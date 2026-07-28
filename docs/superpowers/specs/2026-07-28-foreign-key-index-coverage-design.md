# Foreign-Key Index Coverage Design

## Problem

Prisma's default `foreignKeys` relation mode does not warn when a relation's
owning scalar columns lack a covering index. Auditing a temporary schema with
`relationMode = "prisma"` reveals one such relation in the current schema:
`Workspace.periodicTaskId`.

The temporary relation-mode audit is not suitable as the permanent repository
check. This schema contains cyclic and self relations that are valid with
database-enforced foreign keys but fail Prisma validation under emulated
relations unless their referential actions are rewritten for the audit.

## Considered Approaches

1. Run only the one-time Prisma audit and add the missing index.
   This fixes the current gap but permits later schema changes to introduce the
   same problem.
2. Rewrite the schema into `relationMode = "prisma"` during every check.
   This uses Prisma's warning directly, but requires temporary changes to
   referential actions and couples the check to unrelated cyclic-relation
   validation rules.
3. Add a static foreign-key index checker and the missing index.
   This is the selected approach. It follows the established `iron-fillet`
   pattern, checks exactly the intended invariant, and can run without a
   database or schema rewrite.

## Design

Add `scripts/check-fk-indexes.ts`. It will inspect `prisma/schema.prisma` and
require every owning-side `@relation(fields: [...])` column set to be the
leading columns of an `@@index`, `@@unique`, `@@id`, `@unique`, or `@id`.
Composite foreign keys are covered when their full column set occupies the
leading positions of an index. The checker will report the model, columns, and
suggested index for every violation and exit non-zero.

The checker will retain a documented exemption map for intentionally unindexed
relations. Unknown exemptions and exemptions that become covered will fail so
the allowlist cannot silently become stale. No initial exemptions are needed.

Expose the checker as `pnpm check:fk-indexes` and include it in `pnpm check`.
This makes local and CI guardrails reject future uncovered relation columns.

Add `@@index([periodicTaskId])` to `Workspace` and a SQLite migration containing
the corresponding `CREATE INDEX`. No relation behavior or application query
behavior changes.

## Testing and Validation

Implementation will use the checker itself as the red-green regression:

1. Add and run the checker against the current schema; it must fail only for
   `Workspace.periodicTaskId`.
2. Add the schema index and migration; the same checker must pass.

Final validation will run `pnpm check:fk-indexes`, `pnpm check:prisma-schema`,
`pnpm check`, and `pnpm typecheck`. The migration SQL will also be compared
against Prisma's schema diff so the committed database index matches the schema.
