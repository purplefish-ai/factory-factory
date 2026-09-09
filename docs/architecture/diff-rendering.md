# Diff rendering

The workspace diff viewer displays plain text immediately and requests syntax
highlighting from `diff-highlight.worker.ts`. Whole-diff tokenization runs in a
module worker so multiline syntax is preserved without running Prism on the UI
thread. Vite and Storybook alias the entity decoder to its DOM-free export; the
default browser export requires `document` and cannot run in a worker. A bundle
regression test executes the production-resolved code without DOM globals.
Worker messages are validated, and the worker is terminated after its
reply, on failure, or when its diff/theme changes. Unsupported workers or
languages leave the plain diff usable. Markdown preview does not start a worker.

`DiffLines` mounts all rows for small diffs and a measured virtual window above
200 rows. Wrapped lines are measured at their rendered height. Scroll storage
keeps a row index and offset for virtual diffs, so remounting a tab can restore
the same line even before the full diff has been measured. Width changes discard
stale offscreen heights while preserving the current row anchor. Old pixel-only
scroll records migrate to row anchors by measuring a contiguous prefix in bounded
windows before restoring the requested pixel offset. This one-time migration can
take several frames for a deep position; user gestures cancel it. Intermediate
measurement positions never replace the saved scroll record.

For visual checks, run `pnpm storybook` and open **Workspace / DiffLines**. The
stories cover a small diff, a 10,000-line diff, and wrapped rows. Check the last
line, resize a wrapped diff, and toggle light/dark themes. Virtualized views
only mount visible and overscan rows; native browser text search and selection
operate on that mounted window.

The frontend production build (`pnpm exec vite build`) emits a separate module
worker asset. Focused regression checks:

```sh
pnpm test src/client/features/workspace/diff-viewer.test.tsx src/client/features/workspace/diff-highlight.worker.test.ts
```
