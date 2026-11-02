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
`dist/client/.vite/manifest.json`; dynamic imports load when needed. Compare
both raw and gzip sizes, and smoke-test direct page navigation after changing
split points. Markdown's Storybook stories cover plain text, diagrams, and
render errors.

The workspace feature's public `index.ts` contains shared controls, dialogs, and
hooks used by the shell and other features. Route composition imports workspace
panels directly, as permitted by the feature boundary rules. Keep
`MainViewContent`, `WorkspaceContentView`, `RightPanel`, file viewers, and diff
viewers out of the public barrel; re-exporting them creates an eager path that
bypasses the existing route and viewer lazy imports.

`pnpm check:client-chunks` checks both individual chunks and a 1,300,000-byte
startup static closure. It parses the emitted JavaScript imports and re-exports,
counts each reachable file once, and reports raw bytes plus summed per-file gzip
bytes. The build also emits `assets/client-modules.json`, which maps each
JavaScript chunk to its repository-relative source modules. The gate validates
that manifest and rejects file/diff viewer sources anywhere in the static graph,
including when folded into the entry or a shared chunk. Missing metadata fails
closed. Dynamic imports are excluded. To measure another production build, pass
its assets directory: `pnpm check:client-chunks /tmp/client-build/assets`.
