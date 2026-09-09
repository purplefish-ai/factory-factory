# Knip exclusions

Knip checks the application, tests, stories, CSS, MDX, and Prisma files. It discovers
CLI and backend entry points from package configuration and scripts.

Unused shadcn primitives and their exclusive dependencies were removed in September
2026. The UI directory has no file exclusions: keep components with application or
Storybook consumers, and add others when needed.

The only dependency exclusion is `@prisma/client`, which is imported by generated
Prisma runtime code. It must remain a production dependency.

Knip follows `tw-animate-css` and `@tailwindcss/typography` in
`src/client/globals.css`, and detects the `@agentclientprotocol/claude-agent-acp`
executable dependency. These packages remain in dependency analysis.

See [shadcn maintenance](shadcn.md) for the component refresh and local adaptations.
