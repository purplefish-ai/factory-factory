# Serve prerequisite setup implementation plan

**Goal:** Offer explicit, default-No fixes before starting the server.
**Architecture:** A built-ins-only launcher checks Node before application
imports; the serve action checks Git and optional GitHub setup before
migrations. **Tech stack:** Node ESM, TypeScript, readline, Vitest. **Spec:**
[Approved design](../specs/2026-11-04-serve-prerequisites-design.md).

## Constraints and review focus

Every command requires its own affirmative answer. Noninteractive input, EOF,
cancellation, and blank input execute nothing. Node upgrades require restarting;
Git fixes must be rechecked. Optional GitHub failures must not block local work.
Published packages must include the launcher and version pin. Preserve argument,
exit-code, and signal forwarding. No new dependency or package manager
installer.

## Tasks

- [x] Write failing prerequisite tests covering version boundaries, prompt
      outcomes, command selection, required failures, optional failures, and
      rechecks.
- [x] Implement built-ins-only prerequisite helpers and default-No terminal
      confirmation. Stub command execution in tests to prevent installations.
- [x] Write launcher tests using a temporary package with a fake application:
      old Node never loads the app; supported Node forwards arguments and exit
      codes.
- [x] Add the launcher, wire package bins and source serve scripts, and call
      tool checks before migrations. Ship `.node-version` and verify metadata
      consistency.
- [ ] Update README, run focused tests and required repository checks, inspect
      the diff, and obtain a fresh whole-change review.
- [ ] Commit, push, open the PR, resolve valid feedback, and merge only after CI
      is green and no unresolved review comments remain.

## Execution

Proceed inline under the user's instruction to implement, open a PR, and merge
when green with no outstanding comments. Package-manager support starts with fnm
for Node and Homebrew/WinGet for installations; other setups receive manual
instructions. This keeps shell profile evaluation and distro-specific privilege
changes out of the startup flow.
