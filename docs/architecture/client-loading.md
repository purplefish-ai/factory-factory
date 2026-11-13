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

## Compression

Remote clients (`tailscale serve`, `ff proxy`, the mobile web app) receive the
static client compressed; loopback and Electron get the same bytes, which costs
them nothing. Peer addresses cannot identify remote clients because the tunnels
connect from loopback, so the server keys only on `Accept-Encoding`.

- `vite build` runs `scripts/precompress-assets.ts`, which writes `.br`
  (quality 11) and `.gz` (level 9) siblings beside every output file with an
  allowlisted extension (text formats plus uncompressed `.ttf`, `.otf` and
  `.wasm`) of at least 1 KiB that compresses by 10% or more. Images, woff2 and
  audio are skipped. The siblings ship in the npm package and the desktop app.
- `createPrecompressedStatic` in `src/backend/middleware/` lists the siblings
  once at startup and serves one when the client accepts it, preferring Brotli,
  with the original content type and cache headers, `Content-Encoding`, and
  `Vary: Accept-Encoding`. The SPA fallback serves `index.html` the same way. No
  compression runs at request time.
- API responses are not compressed. The browser client sends tRPC queries
  through `httpBatchStreamLink`, which streams `application/jsonl`; its
  remaining JSON (mutations) is usually small. The workspace MCP server fetches
  queries as ordinary JSON, and automation proposals can reach tens of
  kilobytes, but the MCP server runs on the backend's machine, where compression
  saves nothing. The port-share proxy, health routes and WebSockets are not
  compressed either. Possible follow-ups are compressing the tRPC jsonl stream
  with a flush per line, and WebSocket `permessage-deflate` for large session
  replay frames.

Chunk budgets and `pnpm check:client-chunks` measure the uncompressed files;
siblings do not match their name patterns. A cold load of the startup closure
(`index.html`, entry CSS and the static JS import graph) is about 1.26 MB raw,
330 KB with Brotli and 375 KB with gzip.

## Loading, empty and error states

Pick the loading pattern by what the user is waiting for:

- **`Skeleton`** (`src/components/ui/skeleton.tsx`) when the content's layout is
  known: list rows, cards, thumbnails, dashboard columns. It keeps the layout
  from jumping when data arrives.
- **`Spinner`** (`src/components/ui/spinner.tsx`) for inline pending: a tree row
  that is expanding, a status line next to text, an inline editor that is
  saving. Pass `aria-hidden` when nearby text already says what is pending.
  Don't use a raw `SpinnerGapIcon` or `animate-spin`; `factory/no-raw-spinner`
  rejects them outside status indicators listed in
  [`no-raw-spinner.exceptions.json`](../../lint-rules/rules/no-raw-spinner.exceptions.json).
- **`Loading`** (`src/client/components/loading.tsx`) for a route or panel with
  no known layout. Give it a specific message ("Loading diff…");
  `size="compact"` drops the 200px minimum height for side panels.

Keep inline fallbacks inline: image and link previews can appear inside Markdown
paragraphs, so use a `Spinner` beside their existing label rather than nesting a
`Loading` block inside a `span`. Loading labels in disabled select options and
input placeholders do not need a second spinner when their surrounding control
already communicates the wait.

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
data still renders when only a background refetch fails, under a
`QueryRefreshError` notice with Retry; the content keeps its place in the tree,
so scroll position, focus and open forms survive the notice. The notice sits in
normal flow above the content: put `QueryState` in a `flex-col` parent and give
fixed-height content `min-h-0 flex-1`; inside a card, pass
`refreshErrorClassName="rounded-md border"`, as `SettingsSection` does. Pass
`notFound` to show a not-found state for a tRPC `NOT_FOUND` error, even over
cached data; any other error is a failure, never "not found". Render this
wrapper only when the request is enabled; a disabled query belongs in the
caller's conditional UI. Without data or an error, the request is unresolved,
including when paused offline. `empty` may deliberately be `null`; supply an
`EmptyState` alongside `isEmpty` when the user needs an empty message or next
action. Write branches by hand when a panel combines several queries, as
`CombinedChangesPanel` does, or when the states must fit a menu or tree row;
gate the error on missing data (`error && !data`) and use the same
`QueryErrorState` and `QueryRefreshError` components where they fit. Retry
buttons say "Retry".

Render errors are caught by `ErrorBoundary` (`src/client/error-boundary.tsx`);
do not add another boundary class. The app root and the routed page area each
have one. The page boundary resets when the URL changes. Both offer Reload and
Copy details (message, URL, stack and component trace). The page boundary wraps
lazy route imports, so it uses Reload rather than Try again: a rejected lazy
import stays rejected until the app reloads. Panels and lazy chunks use
`variant="compact"` with a specific `title`, such as "Couldn't load the viewer".
Offer `showRetry` only where re-rendering can succeed; the route, viewer and
form boundaries omit it.

The shell renders the sidebar and banners outside the page boundary, so each has
its own compact boundary, as do the workspace right panel and each transcript
row (`GroupedMessageItemRenderer`). A message that fails to render shows
"Couldn't render this message" in its place; replaying the transcript would
otherwise crash the page again. Agent tool input is untrusted: tool renderers
read it through `parseToolInput` and the schemas in
`tool-renderers/tool-input-schemas.ts`, showing raw JSON when the shape does not
match. Lazy components outside a panel boundary, such as the setup terminal, get
a local boundary.

`installChunkLoadRecovery` (`src/client/lib/chunk-load-recovery.ts`) listens for
`vite:preloadError`, which usually means a deploy replaced the chunks this page
expects, and shows one persistent toast with Reload. It does not cancel the
event, so the import still rejects and the nearest boundary shows the failure.
Unmatched URLs render `routes/not-found.tsx` inside the shell; the root route's
`errorElement` uses the shared fallback for errors that reach the router.

## Pending controls

Every control that fires an RPC shows that it is in flight, the same way:

- **`Button`** takes `pending` and an optional `pendingLabel` ("Saving…").
  Pending disables the button, sets `aria-busy`, and replaces its icon with a
  `Spinner` sized like the button's icons. Text buttons keep the label beside
  the spinner (or show `pendingLabel`); icon-size buttons show only the spinner
  and use `pendingLabel` as their accessible name.
- **`DropdownMenuItem`** takes `pending`: the item is disabled and its icon
  becomes a spinner.
- **`ConfirmDialog`** takes `isPending` and `pendingText`. The confirm button
  shows a spinner beside its label (`pendingText` when given, otherwise the
  confirm label), and the dialog ignores Escape and Cancel until the action
  settles, so callers only pass the mutation's state and close the dialog on
  success.

`factory/use-pending-prop` rejects a `Spinner` (or any spinning element) inside
`Button` or `DropdownMenuItem`. Prefer the mutation's own `isPending`; when one
mutation serves several rows, compare `mutation.variables` or use
`useMutationState` (see `useToggleRatcheting().pendingWorkspaceIds`) so only the
row in flight shows pending. Keep local pending state only where it covers more
than the mutation, such as a refetch the user must see first or a second submit
before React commits. Report each mutation's failure through one channel: the
fallback or options-level toast, or inline UI with
`meta: { errorToast: false }`.

## Query and mutation failures

A failed query must not render its empty state. When a query has an error and no
cached data, render `QueryErrorState` (`src/client/components/`) with the error
message and a Retry that calls `refetch`. Keep showing cached data when only a
background refetch fails, and never gate content on `isError`, which stays true
while cached data is on screen. The `factory/query-error-handled` lint rule
flags a `use…Query` result that reads `isLoading`, `isPending` or
`isInitialLoading` without `error`, `isError`, `status`, `isLoadingError` or
`isRefetchError` ([rule](../../lint-rules/rules/query-error-handled.mjs)).

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
  string such as `meta: { errorToast: "Couldn't start dev server." }`; it is
  shown verbatim, and the server message becomes the description.

Error toasts stay for 10 seconds and have a close button. `toast.error` gets
these defaults from `src/components/ui/sonner.tsx`, because sonner has no
per-type duration. Other toast types keep sonner's 4-second default. Prefer
`toast.error(title, { description: error.message })` over raw server text as the
title.

## Query retries and polling

The app `QueryClient` sets the query defaults once: no refetch on window focus,
and `shouldRetryQuery` as the retry policy. A tRPC error with a 4xx status (not
found, forbidden, invalid input) fails on the first attempt, so a query without
cached data shows its not-found or error UI at once (cached data keeps rendering
as above); network failures, 5xx and non-tRPC errors retry twice with backoff (1
s, then 2 s). Don't restate either default at a call site. When a query must not
retry, use a named reason from `QUERY_RETRY`
(`src/client/lib/query-options.ts`): `costlyRead` for reads that spawn `gh` or a
provider process or call an external service, `permanentServerError` for
procedures that report permanent failures as server errors, and `nextPoll` for a
tight poll whose next tick is the retry.

Polling intervals come from the `POLL_INTERVAL_MS` tiers in the same module,
chosen by what the user is waiting for: `progress` (1 s), `runningProcess` (2
s), `capture` (3 s), `localStatus` (5 s), `activity` (10 s), `workspaceContext`
(15 s), `background` (30 s), `external` (60 s) and `releaseCheck` (1 h).
`factory/named-query-options` rejects numeric `refetchInterval` values,
`refetchOnWindowFocus: false` and literal `retry` values outside `QueryClient`
defaults. It checks the literal written at the option, not what an identifier
resolves to, so define any other interval as a tier rather than a local
constant. `REVIEW_REQUESTS_POLL_MS` is the deliberate exception: it matches the
server's review-request cache lifetime.

## User settings and settings sections

Read and write user settings only through `useUserSettings` and
`useUpdateUserSettings` (`src/client/lib/user-settings-queries.ts`); the
`factory/query-owner` lint rule rejects other `userSettings.get` and
`userSettings.update` hooks and cache helpers. Writes run in order and patch the
cache before the request, so a switch or select shows its new value at once. A
failure restores the fields it changed and shows one "Couldn't save settings."
toast; a newer pending write of the same field keeps its value and inherits the
one to restore if it fails too; when the last pending write settles, the saved
settings are committed and refetched. `isSaving(field)` is true while a write of
that field is pending.

Admin settings cards use `SettingsSection`
(`src/client/routes/admin/settings-section.tsx`). Given a `query`, it renders a
skeleton until data arrives and `QueryErrorState` with Retry if the query fails,
so controls never render editable defaults. Inside it, `SettingRow` (label and
description beside a switch or button), `SettingField` (label above a control)
and `SettingSelect` share the label, help text and saving spinner; size fields
with `SETTING_FIELD_WIDTH`.
