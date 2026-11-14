# Add a service capsule

## Use when

You add a backend domain: a directory under `src/backend/services/` with its own
public API. Read the
[backend services guide](../../src/backend/services/AGENTS.md) first; it holds
the capsule boundary rules these steps follow.

## Steps

`<capsule>` is the capsule's kebab-case name, and the directory's.

1. Write the logic in
   `src/backend/services/<capsule>/service/<capsule>.service.ts` and its test
   beside it, `<capsule>.service.test.ts`. Prisma access goes in `resources/`
   accessors, never in `service/`.
2. Create the barrel `src/backend/services/<capsule>/index.ts` naming every
   public export:
   `export { <name>, type <Type> } from './service/<capsule>.service';`.
   `src/backend/services/host-metrics/index.ts` is the model.
3. Register it in `src/backend/services/registry.ts`: add `'<capsule>'` to
   `serviceNames`, and `'<capsule>': { dependsOn: [], ownsModels: [] },` to
   `serviceRegistry`. List in `dependsOn` each capsule whose barrel this one
   imports outside tests; when another capsule imports this one, add
   `'<capsule>'` to that capsule's `dependsOn`.
4. Use it from its caller through the barrel, `@/backend/services/<capsule>`: an
   orchestration module, a router, or `src/backend/app-context.ts` (which lists
   it in `ApplicationServices` and in the `services` object, as it does
   `hostMetricsService`).
5. Prove the boundaries: both pass.

   ```sh
   pnpm check:ownership && pnpm deps:check
   ```

6. Only if the capsule has ownership or an invariant no check enforces, write
   `src/backend/services/<capsule>/AGENTS.md` stating it, and beside it a
   `CLAUDE.md` holding exactly `@AGENTS.md`; then `pnpm check:guidance` passes.
7. Run `pnpm check:fix`, `pnpm typecheck`,
   `pnpm test src/backend/services/<capsule>` and `pnpm check`; all pass.

## Mistakes this prevents

- `export *` in the barrel: `check:service-registry` fails with
  `list the names it exports explicitly`.
- A directory missing from `serviceNames`: `check:service-registry` fails with
  `is under unregistered service directory`; one missing from `serviceRegistry`
  fails `pnpm typecheck` with `TS2741` in `scripts/check-service-registry.ts`.
- An import of another capsule not in `dependsOn`: `check:service-registry`
  fails with `does not declare it in dependsOn`; a `dependsOn` entry nothing
  imports fails with `no non-test file in the capsule imports it`.
- An import of `<capsule>/service/...` from outside the capsule:
  `pnpm deps:check` fails with `no-deep-service-imports`.
- A capsule nothing imports: Knip fails with its barrel under "Unused files",
  and `check:unused-code` with `New production candidate`.
- An `AGENTS.md` without its `CLAUDE.md`: `pnpm check:guidance` fails with
  `has no sibling CLAUDE.md`.
