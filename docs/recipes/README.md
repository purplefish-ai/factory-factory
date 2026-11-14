# Recipes

A recipe is a procedure that agents repeat, written once so every agent tool
reads the same text. It is 80 lines or fewer, holds procedure only (rules stay
in the `AGENTS.md` of the directory they bind, and the recipe links to them) and
has these parts, in this order:

1. A `#` title.
2. `## Use when`: one or two sentences.
3. `## Steps`: numbered. Each step names the file to touch or the command to
   run, exactly, and the command or observation that proves it worked.
4. `## Mistakes this prevents`: a short list. Each item is a mistake someone
   made, or a check that would otherwise fail.

`pnpm check:guidance` enforces the size and the headings. Each recipe also has
`.claude/skills/<recipe-name>/SKILL.md`: front matter with `name` and a
`description` saying when to use it, and one line pointing at the recipe. The
skill holds no procedure; the check fails a recipe without its skill and a skill
whose recipe is missing.

| Recipe                                                  | Use when                                             |
| ------------------------------------------------------- | ---------------------------------------------------- |
| [verify-in-app](verify-in-app.md)                       | A change is visible to a user and must be driven     |
| [verify-event-automations](verify-event-automations.md) | You changed the event automation runtime or its jobs |
