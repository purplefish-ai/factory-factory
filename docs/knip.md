# Knip exclusions

`knip.json` ignores only exact generated shadcn UI primitive paths. The UI directory is a reusable local component catalog, so generated primitives do not require a current application consumer. Exact paths keep newly added UI files and every non-UI source file in dead-code analysis by default.

Dependency exclusions in `ignoreDependencies` cover framework-discovered or CSS/tooling packages whose usage Knip cannot infer from TypeScript imports.
