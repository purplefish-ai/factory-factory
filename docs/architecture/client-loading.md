# Client Loading

Page components in `src/client/router.tsx` are React lazy imports. The app shell
stays mounted while the outlet's Suspense boundary shows the existing Loading
component. Keep page imports at these split points: an eager import through
another module can pull a page's dependencies back into the startup bundle.

Markdown loads independently of Mermaid. Only a Mermaid code block renders the
lazy `mermaid-diagram.tsx` component and initializes the diagram engine, with
strict security enabled. While that chunk loads, the block displays its source.
Ordinary Markdown and workspace file links do not wait for it.

The sidebar is part of the startup bundle, so its new-workspace form is a lazy
import: launch controls, draft storage and the prompt composer load on the first
"+" click or image drop. The always-mounted image drop zones statically import
only the shared `ImageDropZone` component (with its attachment conversion
helper), `ErrorBoundary`, and a dependency-free queue in
`workspace-creation-drop-queue.ts`. Dropped images wait in memory there until a
lazily loaded drain appends them to the project's persisted creation draft,
whether or not the form chunk has finished loading. If the drain chunk fails to
load, the zone reports the error, discards the queued images and retries on the
next drop. Clearing or discarding a draft resets the queue, so reads still in
flight are dropped as before. Import the composer barrel or draft hooks from
these zones and the whole creation stack, about 125 KB raw and 36 KB gzip,
returns to startup.

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

## Query and mutation failures

A failed query must not render its empty state. When a query has an error and no
cached data, render `QueryErrorState` (`src/client/components/`) with the error
message and a Retry that calls `refetch`. Keep showing cached data when only a
background refetch fails.

`createAppQueryClient` (`src/client/lib/query-client.ts`) installs a
`MutationCache.onError` fallback so that no mutation fails silently. The cache
only sees options passed to `useMutation(...)`: per-call
`mutate(vars, { onError })` callbacks live on the observer, and a `mutateAsync`
rejection goes to its caller. The rule is therefore:

- A mutation with an options-level `onError` handles its own errors; the
  fallback stays quiet.
- A mutation that reports errors per call, through a `mutateAsync` try/catch, or
  with inline error UI sets `meta: { errorToast: false }`.
- Otherwise a failure shows an error toast. Set
  `meta: { errorToast: "Couldn't {verb} {object}" }` for a specific title; the
  server message becomes the description.

Error toasts stay for 10 seconds and have a close button. `toast.error` gets
these defaults from `src/components/ui/sonner.tsx`, because sonner has no
per-type duration. Other toast types keep sonner's 4-second default. Prefer
`toast.error(title, { description: error.message })` over raw server text as the
title.
