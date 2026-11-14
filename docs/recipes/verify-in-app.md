# Verify a change in the running application

## Use when

Your change is visible to a user (a page, a component, a flow) and tests alone
do not show it does what was asked. If no user-visible behaviour changed, skip
this and say so in the pull request's "Driven in the sandbox" section.

## Steps

1. Start the sandbox in the background, from the repository root. It runs the
   real application with its own data, ports and scripted stand-ins for the
   agent; it contacts no real provider, GitHub or Slack. The output goes to a
   file because the first start may build native modules.

   ```sh
   mkdir -p .context/verify && pnpm dev:sandbox --ttl-minutes 60 > .context/verify/sandbox.log 2>&1 &
   ```

2. Wait for the line `SANDBOX_READY <path>` (the path ends in `sandbox.json`).
   It takes seconds, or minutes after a native-module build.

   ```sh
   grep SANDBOX_READY .context/verify/sandbox.log
   ```

3. Copy `sandbox.json` and read `frontendUrl`, `backendUrl`, `repoPath` and
   `pid` (the launcher). The launcher chose free ports; never assume one.

   ```sh
   cp "$(sed -n 's/^SANDBOX_READY //p' .context/verify/sandbox.log)" .context/verify/sandbox.json && cat .context/verify/sandbox.json
   ```

4. Drive the change with a browser tool, starting at `frontendUrl`: the seeded
   project's board. The first load compiles the client and can take two minutes;
   banners saying Claude sign-in is required and the GitHub CLI is missing are
   expected. To create a workspace: "New workspace", type a prompt, keep the
   Codex provider, "Launch", open the new card; the scripted agent (scenario
   `echo`) repeats every message back. Selectors that work are in
   `e2e/sandbox-smoke.spec.ts`. With no browser tool, use a Playwright script.

5. Save one screenshot of the changed state, and notes on what you did and saw,
   in `.context/verify/` (ignored by Git). Browser tools may resolve a file name
   against their own root, not your worktree, and refuse other paths; copy the
   file in if so.

   ```sh
   ls .context/verify/*.png
   ```

6. Stop only your sandbox: signal the launcher recorded in your copy of
   `sandbox.json`. Do not match processes by name; other agents' sandboxes run
   the same command. The log ends with `dev-sandbox: stopping (SIGTERM)`, and
   `pnpm` reports exit code 143.

   ```sh
   kill "$(node -p 'require("./.context/verify/sandbox.json").pid')"
   ```

7. Confirm nothing of yours is left: `baseDir` is gone and no process runs from
   your worktree. Both commands should print nothing but the `ls` error.

   ```sh
   ls "$(node -p 'require("./.context/verify/sandbox.json").baseDir')"
   ps -axo pid,command | grep -F "$PWD" | grep -v grep
   ```

8. In the pull request body, under "Driven in the sandbox", say what you drove
   and what you saw. A screenshot under `.context/` is not part of the pull
   request: describe it, and attach it only if your tool can.

## Mistakes this prevents

- Running `pnpm dev` to check a change: it uses your real database and
  credentials.
- Running the launcher in the foreground of your tool, which then blocks.
- Assuming the ports or the URL instead of reading `sandbox.json`.
- Stopping with `pkill` or `pgrep -f`, which also matches another agent's
  sandbox.
- Leaving the sandbox running, or reporting "verified" from tests alone.
