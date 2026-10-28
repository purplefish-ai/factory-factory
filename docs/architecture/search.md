# Metadata search

The search capsule reads projects, workspaces, named agent sessions, and
attached pull request metadata. It declares dependencies on the workspace and
session capsules, owns no models, and writes no data. Transcript and repository
content are outside the current search scope.

## Query execution

`metadata-search.accessor.ts` opens a short-lived, read-only `better-sqlite3`
connection to the database path supplied by `configService`. It requires an
existing database and closes the connection in `finally`, including on errors.
This connection registers three deterministic SQLite functions:

- `search_matches` applies NFC normalization and lowercasing, then requires
  every query word to occur literally in the combined metadata.
- `search_rank` prefers exact titles, prefixes, and substrings before supporting
  metadata matches. Empty queries rank equally and show recent items.
- `search_epoch` converts numeric and legacy text timestamps to milliseconds so
  recency ordering stays consistent across stored timestamp formats.

Matching, archive filtering, ranking, recency ordering, and `LIMIT` execute in
SQLite before rows are returned and validated with Zod. Only the bounded result
set is hydrated in JavaScript; Unicode queries must not fall back to loading
every candidate into the application. The query still scans current metadata;
there is no persistent search index or background indexing job.

Workspace metadata includes descriptions, branches, issue identifiers, and
attached PR titles and numbers. Pasted HTTP(S) queries also match saved PR,
GitHub issue, and Linear issue URLs. Ordinary text queries exclude URLs to avoid
matching common URL boilerplate. Detached PRs contribute neither titles,
numbers, nor URLs. The service adds a short metadata snippet when a match is
absent from the visible title and subtitle. Truncation removes surrogate halves
at the snippet edges to keep emoji text well formed.

## Client behavior

The header button and Cmd/Ctrl+K open a dialog with a 150 ms debounce for local
metadata. Loading states hide stale results, including during cache refresh.
Archived results are opt-in and open a read-only preview; its content stays
populated during dismissal. Active conversation results navigate using
`?session=` and select the chat tab, including when a saved file tab would
otherwise be restored.

A separate GitHub issues group searches active projects' linked repositories,
including issues not assigned to the current user. Bare numbers and `#123`
automatically look up an exact issue, including closed issues. Text queries
require selecting **Search GitHub issues** before any external request; editing
the text requires submitting it again. This avoids per-keystroke fan-out across
repositories. Identical query results are treated as fresh in the client for 60
seconds. GitHub loading or partial failures leave local results selectable, and
failures can be retried.

Selecting **Start issue** opens the existing issue launch sheet with the full
prompt and provider/mode options. Cmd/Ctrl+K leaves that sheet and edited
options intact until it is dismissed. A local error boundary contains lazy-load
failures and offers dismissal so the rest of the app and search remain usable.

The dialog uses cmdk for result navigation. Its Enter handler consumes events,
so header and footer buttons sit outside the command root. The retry button
inside the results stops Enter propagation to preserve native activation.
Automatic selection waits while local results load or fail, so returning local
matches take priority over GitHub rows. Explicit keyboard choices remain stable
when GitHub results arrive.

Search regressions live beside the service and client feature; conversation
navigation tests live beside the workspace routes. See the shared
[verification requirements](../../CONTRIBUTING.md#verification).
