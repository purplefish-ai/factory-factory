# Active plans

`plans/` holds plans for work in progress. A plan is deleted by the pull request
that completes it, so a plan here has unfinished steps. Follow one only when the
current task selects it, after checking its assumptions against the code; a
checked step does not establish current behavior.

Completed and superseded plans and specs are preserved at the tag
`docs-archive-2026-11`. Read one with `git show docs-archive-2026-11:<path>`,
and list a directory with
`git ls-tree -r --name-only docs-archive-2026-11 -- docs/superpowers`.

Use the [documentation index](../README.md) and
[architecture notes](../architecture/README.md) for current behavior. Do not
describe current behavior in a plan; the tests hold it. When an implementation
changes an invariant or a reason, change the current subsystem note.
