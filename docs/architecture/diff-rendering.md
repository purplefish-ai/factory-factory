# Diff rendering

The workspace diff viewer displays plain text immediately and requests syntax
highlighting from `diff-highlight.worker.ts`. Whole-diff tokenization runs in a
module worker so multiline syntax is preserved without running Prism on the UI
thread. Vite and Storybook alias the entity decoder to its DOM-free export; the
default browser export requires `document` and cannot run in a worker. A bundle
regression test executes the production-resolved code without DOM globals.
Worker messages are validated, and the worker is terminated after its reply, on
failure, or when its diff/theme changes. Unsupported workers or languages leave
the plain diff usable. Markdown preview does not start a worker.

`DiffLines` mounts all rows for small diffs and a measured virtual window above
200 rows. Wrapped lines are measured at their rendered height. Scroll storage
keeps a row index and offset for virtual diffs, so remounting a tab can restore
the same line even before the full diff has been measured. Width changes discard
stale offscreen heights while preserving the current row anchor. Old pixel-only
scroll records migrate to row anchors by measuring a contiguous prefix in
bounded windows before restoring the requested pixel offset. This one-time
migration can take several frames for a deep position; user gestures cancel it.
`useDiffScroll` owns the virtualizer and a `DiffScrollController` that
coordinates restoration, interruption, and persistence. Its single
animation-frame loop uses measured row coordinates and writes directly to the
viewport; it never starts TanStack's separate `scrollToIndex`/`scrollToOffset`
reconciliation loop. Legacy migration uses that same write path. During
restoration, mounted rows are sampled in that frame because normal scroll-time
measurements arrive asynchronously.

All programmatic writes, including TanStack's measurement adjustments through
`scrollToFn`, are recorded by the controller. A gesture stops restoration but
retains the intended anchor. Queued scroll events at programmatic positions
cannot save intermediate state; actual user movement takes over and permits
persistence. A width change resumes the intended anchor unless the user has
moved. Restoration commits only after measured alignment settles; exhausting its
frame budget keeps the saved target intact. Unmount cancels the controller's
outstanding frame. Intermediate measurement positions never replace the saved
scroll record.

For visual checks, run `pnpm storybook` and open **Workspace / DiffLines**. The
stories cover a small diff, a 10,000-line diff, and wrapped rows. Check the last
line, resize a wrapped diff, and toggle light/dark themes. Use **Restored
Wrapped Position** to check hide/show and narrow/widen preserve row 500 with its
intra-row offset. Click immediately after showing the diff, then hide/show
again: the saved anchor should survive the interrupted restore. Wheel, touch,
keyboard scrolling, and scrollbar dragging should take over without snapping
back. Virtualized views only mount visible and overscan rows; native browser
text search and selection operate on that mounted window.

The frontend production build (`pnpm exec vite build`) emits a separate module
worker asset. Focused regression checks:

```sh
pnpm test src/client/features/workspace/diff-lines.test.tsx src/client/features/workspace/diff-viewer.test.tsx src/client/features/workspace/diff-highlight.worker.test.ts
```
