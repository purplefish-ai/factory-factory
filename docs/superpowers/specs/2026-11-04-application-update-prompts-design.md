# Application update prompts design record

This records the design rationale agreed on November 4, 2026. Current behavior
lives in [Updating](../../../README.md#updating),
[Agent Runtime](../../architecture/agent-runtime.md), and
[Background Jobs](../../architecture/background-jobs.md). See the
[implementation record](../plans/2026-11-04-application-update-prompts.md) for
execution context.

## User-approved scope

The user requested dismissible prompts for newer Factory Factory releases and
consistent handling of simultaneous updates, including Claude. They accepted
installation on click and waiting for agents to become idle before restarting.
The design included supported automatic installation, manual guidance for other
installations, and a recovery path for failed installation or restart.

## Design rationale

A shared nonblocking notice list fit the existing banner conventions. Separate
application and provider prompts would duplicate state and layout; a blocking
dialog would interrupt normal use and make registry outages disruptive.

Bundled providers belong to the application release. Updating a global provider
CLI would not update the runtime the app uses, so the design retained bundled
ownership and chose one installation action for simultaneous notices. Exact
runtime metadata was needed because dependency ranges do not establish the
bundled version.

Agent idleness means no active turns, queued prompts, or pending starts. Idle
ACP processes can remain alive indefinitely, so waiting for their exit would
prevent updates. Admission must close with the final idle check to prevent new
work racing shutdown. Terminals and run scripts need an explicit restart
interruption disclosure.

The CLI supervisor was chosen to outlive the replaced backend and retain update
status. Staging before activation preserves the running installation through
preparation failures. Database backup was included because package rollback
alone cannot safely undo migrations. Packaged desktop updates were left as a
separate installation mechanism rather than invoking global npm from Electron.
