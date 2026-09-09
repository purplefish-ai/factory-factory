# Client Loading

Page components in `src/client/router.tsx` are React lazy imports. The app shell
stays mounted while the outlet's Suspense boundary shows the existing Loading
component. Keep page imports at these split points: an eager import through
another module can pull a page's dependencies back into the startup bundle.

Markdown loads independently of Mermaid. Only a Mermaid code block renders the
lazy `mermaid-diagram.tsx` component and initializes the diagram engine, with
strict security enabled. While that chunk loads, the block displays its source.
Ordinary Markdown and workspace file links do not wait for it.

Use `pnpm exec vite build --manifest` to inspect the production chunks. The
initial JavaScript cost includes the entry and its transitive static imports in
`dist/client/.vite/manifest.json`; dynamic imports load when needed. Compare both
raw and gzip sizes, and smoke-test direct page navigation after changing split
points. Markdown's Storybook stories cover plain text, diagrams, and render errors.
