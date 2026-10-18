# Dependency analysis records

The checked-in hotspot report and metrics are historical snapshots. Their module
paths, counts, and refactor goals describe the analyzed revision, not today's
architecture. Use the
[current architecture notes](../docs/architecture/README.md) and
[area guides](../AGENTS.md#architecture-and-style) for ongoing work.

`analyze-deps.sh` generates dependency-cruiser data and monthly metrics:

```sh
./.architecture/analyze-deps.sh
```

Generated `deps-*.json` files contain raw dependency data; `metrics-*.json`
files summarize it. Compare reports only with their analysis dates and source
revisions in mind. Current boundary enforcement lives in
`.dependency-cruiser.cjs` and `src/backend/services/registry.ts`, checked by
`pnpm deps:check` and `pnpm check:ownership`.
