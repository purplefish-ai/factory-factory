# Application update prompts

Status: implemented in this change; see the current installation and runtime
guides for the supported behavior.

## Intent

When an installed Factory Factory release is behind the latest stable release,
show its current and available versions and an Update action. For example,
someone running 0.5.3 sees that 0.5.4 is available. Checking for or installing
an update must tolerate npmjs being unreachable. Notices are dismissible.

The user also requested consistent prompts and support for simultaneous updates,
including Claude. The user accepted installing on click and waiting for agents
to become idle before restarting.

## Approach

Use a shared list of update notices in the existing application banner area.
Reuse its muted background, border, small buttons, spinner, warning/error
colors, and accessible dismiss controls. Keep setup/authentication problems in
the existing CLI health banner. Give each update its own stable identity and
available version, so dismissing one does not hide another or a later release.

Alternatives considered:

- Separate application and provider prompts would duplicate state and layout
  logic and make simultaneous updates harder to scan.
- A blocking update dialog would interrupt normal use and make registry failures
  unnecessarily disruptive.
- A shared, nonblocking list fits the requested behavior and existing banner
  conventions. This is the proposed implementation choice.

## Managed providers

Claude and Codex are bundled with Factory Factory. Installing a newer global
Claude or Codex CLI does not update the runtime used by the app. Preserve that
contract instead of reinstating the obsolete global-provider upgrade action.

Represent managed runtime updates as separate rows when the available Factory
Factory release includes newer runtime packages. Explain that they update with
Factory Factory and share its installation progress. One application update can
therefore resolve several visible notices. Do not promise a newer upstream
Claude release that is not included in a Factory Factory release. Use package
versions consistently when comparing bundled runtime packages; do not compare an
SDK package version to the CLI's version string.

Implementation choice: discover provider versions from explicit release runtime
metadata or the staged package's resolved adapter dependencies. Dependency
ranges in the registry manifest alone cannot establish a bundled runtime's
version.

## Detection and dismissal

- Resolve the running application's version from its installed package, rather
  than relying on npm launch environment variables.
- Check the latest stable Factory Factory release on the backend with a short
  timeout, validated responses, an in-flight request shared between callers, and
  a cache to avoid repeated registry traffic.
- Fetch checks independently if more update sources are added; one unavailable
  source must not suppress successful results from another.
- Treat timeouts, offline operation, HTTP failures, and invalid metadata as an
  unavailable check. Keep the application usable and avoid an automatic error
  banner. Retain previously confirmed update information when appropriate.
- Persist dismissal per update identity and available version, tolerating
  unavailable browser storage. A later release becomes visible again.

## Installation and restart

The first supported automatic installation target is a global npm installation
started with `ff serve`, matching the documented regular-use installation.
Detect the actual installation and prefix; never blindly update a different
global copy. Development checkouts, containers, other package-manager installs,
and packaged desktop builds need installation-specific guidance rather than an
Update button that reports false success.

The server accepts an update request only from a trusted local client. Pin it to
the validated advertised release, serialize installation requests, and run fixed
executable arguments without shell interpolation or privilege elevation.

An accepted request visibly waits while agents are busy. Before replacing the
installation, prevent new work from racing the final idle check, gracefully
drain the backend, and hand installation/restart to its CLI supervisor. Preserve
the launch options, database, and address. The browser reconnects and reloads
after the new server reports readiness; it must not label the release installed
merely because the installation command was started.

Implementation choice: idle means no active agent turns, queued prompts, or
pending starts, rather than no live ACP processes. Idle processes can remain
alive indefinitely. The restart must account for terminals and run scripts; the
prompt must disclose any interruption instead of promising their seamless
continuation.

Prepare and verify the replacement before activation and retain a recoverable
previous installation. Installation or restart failures must leave a usable
recovery path and surface a concise, dismissible error with retry. Waiting can
be cancelled before installation begins. Dismissing a notice only hides it; it
does not silently cancel an update already requested.

Implementation choice: the supervisor owns durable update status outside the
replaced package, including errors reported after the backend stops. Back up the
database before the new release runs migrations. Package rollback alone is not
database rollback: after migrations, do not automatically start an older release
against the database without verified compatibility or restoration.

Packaged Electron updates are a separate installation mechanism. The shared
notice model should accommodate that mechanism without running a global npm
update from the desktop backend.

## Verification

Add focused tests for version detection/comparison, invalid and unavailable
registry responses, cache and concurrent requests, installation eligibility,
trusted-local access, multiple notices, version-specific dismissal, shared
provider progress, and failures. Cover queued installation, idle transitions,
launch-option preservation, failed activation/restart recovery, and successful
reconnection. Add Storybook states for simultaneous application/Claude updates,
waiting, installation, retry, and dismissal using the existing conventions.

Follow the repository verification policy and update the current installation
and runtime documentation with the supported behavior and limitations.
