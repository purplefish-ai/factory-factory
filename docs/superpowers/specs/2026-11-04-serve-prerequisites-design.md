# Serve prerequisite setup

## Intent

Help CLI users resolve missing prerequisites before `serve` starts migrations or
child processes. Offer to execute fixes interactively. Every prompt defaults to
**No**; only an explicit affirmative answer authorizes the displayed fix.

## Approach

Instruction-only diagnostics are simpler but leave users to perform every fix.
The user chose interactive offers instead. Keep those offers in the startup path
rather than adding a separate setup command users must discover.

A small entry point using Node built-ins checks the Node requirement before
loading application dependencies. A check inside the existing Commander action
alone cannot reliably diagnose Node incompatibility: static imports execute
first. Keep the supported Node requirement aligned with package metadata and the
repository pin, including in the published package. Preserve other CLI commands
and Electron's bundled runtime behavior.

## Checks and recovery

- Unsupported Node blocks startup. Report detected and required versions. Offer
  a fix through an already installed, supported package/version manager when
  available; otherwise provide manual installation guidance. Do not install a
  new package manager. After changing Node, explain how to activate it and rerun
  `serve`; do not continue using the original Node process.
- Missing Git blocks startup. Offer installation through an available supported
  package manager, then recheck availability before continuing.
- Missing GitHub CLI or authentication produces a warning and offers
  installation or `gh auth login`. Declining or failing this optional setup
  still allows startup, since local work does not require GitHub integration.
- Provider authentication remains in existing onboarding and Settings. Do not
  require Claude credentials when a user intends to use Codex.

Package-manager detection and platform-specific command selection are
implementation choices. Prefer existing tools, verify commands against their
official documentation, and provide manual guidance when no supported automatic
fix is available.

## Prompt behavior

Show the problem and exact command before asking `Run this command? [y/N]`.
Empty input, a negative answer, EOF, cancellation, or a noninteractive terminal
executes no fix. Do not add an automatic yes flag. Each command requires its own
affirmative answer; agreeing to one fix does not authorize the next.

Run accepted commands with visible output and inherited terminal input, close
the prompt before launching them, and report failures with manual recovery
instructions. Recheck fixed prerequisites. Stop with a nonzero exit code if a
required prerequisite remains unresolved; keep optional failures as warnings.
Healthy startup should not prompt.

## Verification and documentation

Cover supported and unsupported Node versions, execution before application
imports, missing tools, optional authentication, each prompt outcome, command
failure, rechecks, and noninteractive behavior. Test command planning and
execution with stubs so tests never install tools or authenticate accounts.
Verify the published entry point and existing command forwarding. Update the
README with startup checks, default-No consent, and manual fallback behavior.
Run the repository's required formatting, type, test, and final checks.
