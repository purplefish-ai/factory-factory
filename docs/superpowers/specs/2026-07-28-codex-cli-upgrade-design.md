# Codex CLI 0.145.0 Upgrade Design

## Goal

Upgrade the Codex CLI version enforced by CI from `0.101.0` to the current
stable release, `0.145.0`, while preserving reproducible schema-drift checks.

## Scope

- Change the exact `@openai/codex` version installed by the CI checks job to
  `0.145.0`.
- Regenerate the checked-in Codex app-server method snapshot with Codex CLI
  `0.145.0`.
- Review the generated snapshot diff so new or removed app-server methods are
  intentional consequences of the CLI upgrade.
- Leave the Docker image's intentionally unpinned Codex installation unchanged.
- Do not change application behavior, model configuration, prompts, or runtime
  dependency declarations.

## Implementation

The CI workflow remains the source of truth for the exact Codex CLI release
used by schema validation. The schema snapshot remains coupled to that release
through its `codexCliVersion` field. Both files must change together so CI
installs the same release that generated the committed snapshot.

Generate the snapshot with a locally installed `@openai/codex@0.145.0` by
running the repository's existing `check:codex-schema:update` command. No new
scripts, dependencies, or abstractions are needed.

## Error Handling

If Codex `0.145.0` cannot generate the TypeScript app-server schema, or if the
generated files no longer match the snapshot script's expected inputs, stop
and diagnose that compatibility break instead of weakening the drift check.
Unexpected removals from the method snapshot must be inspected before the
result is accepted.

## Verification

Run these checks after the update:

1. `CODEX_SCHEMA_CHECK=strict pnpm check:codex-schema`
2. `pnpm check`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`

The change is complete when the exact CI pin and snapshot version both report
`0.145.0`, the generated method changes have been reviewed, and all verification
commands pass.
