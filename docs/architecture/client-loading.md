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

## Loading, empty and error states

Pick the loading pattern by what the user is waiting for:

- **`Skeleton`** (`src/components/ui/skeleton.tsx`) when the content's layout is
  known: list rows, cards, thumbnails, dashboard columns. It keeps the layout
  from jumping when data arrives.
- **`Spinner`** (`src/components/ui/spinner.tsx`) for inline or button pending:
  a button whose action is running, a tree row that is expanding, a status line
  next to text. Pass `aria-hidden` when nearby text already says what is
  pending. Don't use a raw `SpinnerGapIcon` with `animate-spin`.
- **`Loading`** (`src/client/components/loading.tsx`) for a route or panel with
  no known layout. Give it a specific message ("Loading diff…");
  `size="compact"` drops the 200px minimum height for side panels.

Keep inline fallbacks inline: image and link previews can appear inside Markdown
paragraphs, so use a `Spinner` beside their existing label rather than nesting a
`Loading` block inside a `span`. A pending action replaces its static action
icon with `Spinner`; the idle action retains its icon. Loading labels in
disabled select options and input placeholders do not need a second spinner when
their surrounding control already communicates the wait.

Spinners inherit the surrounding text color. `Loading` places them in muted
text, so a page-level wait reads as muted, and a button spinner matches the
button's label on every variant. Don't color spinners with `text-brand`: brand
is the Factory Yellow accent, which the default themes also use for the
`running` status (see `docs/status-colors.md`), so a brand spinner reads as an
agent at work rather than a wait. Status icons that do mean "running", such as
the tool-call and session indicators, keep their tone from `status-tones.ts`.

Under `prefers-reduced-motion: reduce`, `globals.css` stops `animate-spin`,
`animate-pulse`, `animate-ping` and `animate-bounce` everywhere. Spinners keep
their shape and accessible label and skeletons stay as static blocks, so
components don't need their own `motion-reduce:` classes for these utilities.

Use `EmptyState` (`src/client/components/empty-state.tsx`) when a loaded list or
panel has nothing to show. It takes an icon, a one-line title with no trailing
period ("No screenshots yet"), an optional description sentence, and an optional
action. When the user can create the missing thing, the action is that creation
button ("Take screenshots", "New child workspace"). Use `size="compact"` in side
panels and lists.

`QueryState` (`src/client/components/query-state.tsx`) wraps the four branches
of a query: `Loading` (or a `loading` override such as a skeleton) while there
is no data, `QueryErrorState` with Retry when the query failed without data,
`empty` when `isEmpty(data)` is true, and `children(data)` otherwise. Cached
data still renders when only a background refetch fails. Write branches by hand
when a panel combines several queries, as `CombinedChangesPanel` does.

Render errors are caught by `ErrorBoundary` (`src/client/error-boundary.tsx`).
The app root and the routed page area each have one. The page boundary resets
when the URL changes. Both offer Reload and Copy details (message, URL, stack
and component trace). The page boundary wraps lazy route imports, so it uses
Reload rather than Try again: a rejected lazy import stays rejected until the
app reloads. Panels and lazy chunks use `variant="compact"` with a specific
`title`, such as "Couldn't load the viewer". Offer `showRetry` only where
re-rendering can succeed; the route, viewer and form boundaries omit it.

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
- Otherwise a failure shows an error toast. For a specific title, set a literal
  string such as `meta: { errorToast: "Couldn't start dev server" }`; it is
  shown verbatim, and the server message becomes the description.

Error toasts stay for 10 seconds and have a close button. `toast.error` gets
these defaults from `src/components/ui/sonner.tsx`, because sonner has no
per-type duration. Other toast types keep sonner's 4-second default. Prefer
`toast.error(title, { description: error.message })` over raw server text as the
title.
