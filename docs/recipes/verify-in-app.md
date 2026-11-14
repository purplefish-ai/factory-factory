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

2. Wait up to five minutes for the line `SANDBOX_READY <path>`, then copy that
   `sandbox.json` and read `frontendUrl`, `backendUrl`, `repoPath` and `pid`
   (the launcher). The launcher chose free ports; never assume one. If the copy
   fails, the launcher did not start: `.context/verify/sandbox.log` says why.

   ```sh
   for i in $(seq 300); do grep -q SANDBOX_READY .context/verify/sandbox.log && break; sleep 1; done; cp "$(sed -n 's/^SANDBOX_READY //p' .context/verify/sandbox.log)" .context/verify/sandbox.json && cat .context/verify/sandbox.json
   ```

3. Drive the change with a browser tool, starting at `frontendUrl`: the seeded
   project's board. The first load compiles the client and can take two minutes;
   banners saying Claude sign-in is required and the GitHub CLI is missing are
   expected. To create a workspace: "New workspace", type a prompt, keep the
   Codex provider, "Launch", open the new card; the scripted agent (scenario
   `echo`) repeats every message back. Selectors that work are in
   `e2e/sandbox-smoke.spec.ts`. With no browser tool, use a Playwright script.

4. Save one screenshot of the changed state, and notes on what you did and saw,
   in `.context/verify/` (ignored by Git). Browser tools may resolve a file name
   against their own root, not your worktree, and refuse other paths; copy the
   file in if so. The listing shows the screenshot with a time from this run.

   ```sh
   ls -l .context/verify/*.png
   ```

5. Stop only your sandbox: signal the launcher recorded in your copy of
   `sandbox.json`, if that pid is still a launcher, and wait for it to exit. Do
   not match processes by name; other agents' sandboxes run the same command.
   The log ends with `dev-sandbox: stopping (SIGTERM)`, and `pnpm` reports exit
   code 143. If nothing is signalled, the launcher had already stopped.

   ```sh
   pid=$(node -p 'require("./.context/verify/sandbox.json").pid'); ps -p "$pid" -o command= | grep -q dev-sandbox.mjs && kill "$pid" && while kill -0 "$pid" 2>/dev/null; do sleep 1; done
   ```

6. Confirm nothing of yours is left: `baseDir` is gone, and no process has your
   worktree path in its command line. Expect only the `ls` error.

   ```sh
   ls "$(node -p 'require("./.context/verify/sandbox.json").baseDir')"
   ps -axo pid,command | grep -F "$PWD" | grep -v grep
   ```

7. Put what you drove and saw under "Driven in the sandbox" in the pull request
   body, and describe the screenshot: `.context/` is not part of the pull
   request. The body shows it after you create or edit the pull request.

   ```sh
   gh pr view --json body --jq .body | grep -A3 'Driven in the sandbox'
   ```

## Mistakes this prevents

- Running `pnpm dev` to check a change: it uses your real database and
  credentials.
- Running the launcher in the foreground of your tool, which then blocks.
- Assuming the ports or the URL instead of reading `sandbox.json`.
- Stopping with `pkill` or `pgrep -f`, which also matches another agent's
  sandbox.
- Leaving the sandbox running, or reporting "verified" from tests alone.
