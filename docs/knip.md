# Knip exclusions

`knip.json` ignores only exact generated shadcn UI primitive paths. The UI directory is a reusable local component catalog, so generated primitives do not require a current application consumer. Exact paths keep newly added UI files and every non-UI source file in dead-code analysis by default.

The project patterns include TypeScript, CSS, MDX, and Prisma files. Knip discovers the CLI and backend entry points from the package configuration and scripts.

Dependency exclusions in `ignoreDependencies` cover:

- `@prisma/client` is referenced by Prisma-generated runtime code.
- Radix, carousel, form, chart, OTP, and drawer packages imported by the exact generated UI primitives listed in the file-ignore section of `knip.json`.

Knip follows the `tw-animate-css`, `tailwindcss-animate`, and `@tailwindcss/typography` directives in `src/client/globals.css` and detects the `@agentclientprotocol/claude-agent-acp` executable dependency. These packages are included in dependency analysis.
