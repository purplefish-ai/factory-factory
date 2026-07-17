# Knip exclusions

`knip.json` ignores only exact generated shadcn UI primitive paths. The UI directory is a reusable local component catalog, so generated primitives do not require a current application consumer. Exact paths keep newly added UI files and every non-UI source file in dead-code analysis by default.

Dependency exclusions in `ignoreDependencies` are grouped as follows:

- `tw-animate-css`, `tailwindcss-animate`, and `@tailwindcss/typography` are loaded through directives in `src/client/globals.css`.
- `@prisma/client` is referenced by Prisma-generated runtime code.
- `@agentclientprotocol/claude-agent-acp` is resolved dynamically as an executable package by the ACP runtime manager.
- The remaining Radix, carousel, form, chart, OTP, and drawer packages are imported by the exact generated UI primitives listed in the file-ignore section of `knip.json`.
