# Targeted ACP stopping

Implement issue #2758. Users can interrupt one background process or native
subagent through its existing list without interrupting unrelated work.

## Approved UI

- Add a right-aligned, always-visible muted filled-square icon beside each
  controllable background process in the expanded chat activity list and each
  controllable subagent in the Sessions panel. Reuse the composer Stop style.
- Tooltips are `Stop process` and `Stop subagent`. Accessible names append the
  row label, such as `Stop process: pnpm test` and `Stop subagent: Researcher`.
- Clicking immediately requests interruption. The icon becomes a disabled
  spinner while awaiting provider confirmation. Existing status updates own
  completion. Errors use the existing toast and allow retry when still valid.
- Preserve row selection separately from stopping; never nest buttons.
- No controls for completed, historical, unsupported, disconnected, or stale
  runtime items. No new transcript-tab controls or confirmation dialog.

## Approaches

The selected approach adds controls directly to the two existing item lists.
Hover-only controls were considered but reduce discovery and touch usability.
Transcript-tab controls were deferred to keep Stop distinct from Close.

## Runtime contract

Retain validated live cancellation capabilities and opaque ownership identities.
Use `_session/async_task/stop` for supported background tasks and
`session/cancel` with the current child ACP ID for native subagents. Revalidate
on the server; UI visibility alone never authorizes a stop. Never resume a
runtime just to stop an old item, and never turn a child stop into a parent
stop. Provider-supported descendant cancellation is allowed; unrelated siblings
remain untouched.

Keep existing replay suppression, generation fencing, permission handling,
capsule boundaries, and read-only review protections. Record requests pending
until live completion/capability withdrawal, with a 15-second confirmation
deadline measured from the initial request. Expiration clears only the pending
request, shows an error toast and permits retry if the current capability
remains valid; provider work/status is unchanged. Provider acknowledgment has a
separate 10-second server deadline.

## Verification

Cover native/legacy capability handling, stale runtime and child generations,
replay/history, unsupported tasks, parent/sibling isolation, request failures,
pending icons, selection behavior, and accessible names. Update stories and
agent-runtime documentation. Run repository-required checks and UI verification.
