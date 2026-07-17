# Knip Coverage Cleanup Design

## Goal

Make Knip analyze backend root services and orchestration files, remove obsolete migration-era configuration and request-scoping code, and leave only narrow, explained exclusions.

## Scope

- Remove stale Knip ignores for deleted domain/resource-accessor layouts, backend service roots, orchestration files, and barrels that no longer need protection.
- Remove the redundant explicit `src/client/main.tsx` entry; Vite discovers it.
- Delete the unused `src/backend/clients/index.ts` compatibility barrel exposed by broader analysis.
- Remove `projectId` and `topLevelTaskId` from tRPC request context, stop parsing their headers, delete the unused `projectScopedProcedure`, remove the client provider state and header generation that fed those headers, and remove the headers from CORS.
- Replace the broad `src/components/ui/**` exclusion with exact paths for the 19 currently unused generated shadcn primitives. Document the generated-catalog reason in `docs/knip.md` so newly added UI files are analyzed by default.

## Approaches Considered

1. **Remove broad ignores and resolve every exposed result (recommended).** This gives orchestration and root services real dead-file coverage and produces a small, evidence-backed cleanup.
2. **Replace broad ignores with per-file ignores.** This would make the configuration look narrower while preserving blind spots and requiring ongoing manual maintenance.
3. **Promote exposed files to Knip entries.** Marking ordinary modules as entries would hide dead code instead of proving that runtime import paths reach it.

## Design

Knip remains configured around runtime/framework entry discovery. Backend root services and orchestration modules are ordinary project files and receive no special exclusion. The remaining file ignores name only currently unused generated shadcn UI primitives, with their shared reason in `docs/knip.md`.

The tRPC context retains only request trust metadata and the application context. Project selection continues to be supplied explicitly in individual procedure inputs, which is already the production pattern; the client no longer tracks ambient tRPC project/task state or sends unused scope headers, and CORS no longer advertises them.

## Testing and Verification

- Add regression assertions that request-scope headers do not become tRPC context fields and are absent from the CORS allow-list, observe both fail before changing production code, then make them pass.
- Use the stricter temporary Knip configuration as the red check: it currently reports `src/backend/clients/index.ts` unused and `src/client/main.tsx` as a redundant entry.
- Run `pnpm knip` with configuration hints treated as errors, targeted tRPC tests, repository checks, typecheck, full tests, and build.

## Edge Cases

- Preserve `requestTrust`; it enforces the HTTP trust boundary for privileged mutations.
- Do not remove explicit project IDs from procedure input schemas; only ambient, unused request headers are removed.
- Do not turn test-only imports into production entry declarations. Test files remain discovered by the Vitest plugin.
- Keep the existing tRPC provider and query client lifetimes stable while removing their now-unused context wrapper and refs.
- Keep `knip.json` strict JSON for Biome compatibility; document exclusions outside the configuration rather than relying on JSON comments.
