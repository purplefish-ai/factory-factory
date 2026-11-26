# Reliable first launch for the published CLI

**Goal.** A new user can launch Factory Factory with one command on a supported
Node installation, get a working database and terminal, and repeat the command
after switching from Node 24 to 26.

**Design.** Test the tarball a user installs. Align its SQLite dependencies,
diagnose native load failures before opening user data, then use consumer tests
to set the Node 24 minimum. The build uses the repository's pinned Node and
pnpm. The consumer tests exercise npm and npx as shipped to users.

**Scope.** The incident is consistent with a stale native binding. The original
stack trace, binary path and package versions are unavailable. The steps below
distinguish an install failure, a launcher failure and a backend failure. Each
has a different fix.

## 1. Reproduce the installation and exercise a real launch

- [ ] Extend the existing packed-artifact check in
      `.github/workflows/npm-publish.yml`. Pack once under the development pin.
      Pass that exact tarball to consumer jobs and through to staging. Keep
      release provenance, approval and dry-run behavior intact.
- [ ] In `scripts/check-installed-native-runtime.mjs`, resolve
      `better-sqlite3/package.json` once from the installed app and once from
      the installed Prisma adapter using `createRequire`. Record both versions
      and real paths, the executing Node version, native ABI, OS and
      architecture. Open an in-memory database from each distinct resolution.
      Capture the current tarball's result before changing dependencies.
- [ ] Add a packed-serve smoke runner. Start in an empty directory with a
      private npm cache, temporary `BASE_DIR`, temporary database, loopback
      address and `--no-open`. Use the consumer's npm exec with the tarball as
      its package argument. Fetch the UI and require HTTP 200 with
      `database: "connected"` from `/health/database`. Keep the real PTY
      spawn/output check. For the end-to-end case, open the setup terminal
      through the running server with a loopback Origin, send an echo command
      and assert its output. Use a bounded timeout, retain stderr and stop the
      process tree on every exit.
- [ ] Exercise a cold Node 26 launch first. Then install the same tarball under
      24 and relaunch under 26 using the same absolute package spec, working
      directory and cache. Record whether the first attempt failed during
      installation or reached our Node gate. Verify the same npx entry was
      reused on the second attempt. Record the ordinary upgrade outcome
      separately from a deliberately damaged test fixture.

## 2. Ship one SQLite driver

- [ ] Turn the resolution report into a release assertion. Both callers must
      resolve the same real driver path. A migration and a request to
      `/health/database` must succeed in the installed package. A matching
      version string alone allows two physical copies.
- [x] The latest released Prisma adapter (7.10.1) requests SQLite v12. A
      disposable shrinkwrap produced one driver during packaging, but npm
      installed a second copy, v12.11.1, in the consumer tree.
- [ ] Bundle the pinned upstream adapter JavaScript in the build, include its
      license, and keep the native v13 driver external. Use the bundled adapter
      for both normal database operations and backups. Verify this packaging
      decision with a fresh tarball install and an Electron launch.
- [ ] Run migration, Prisma query and Electron native-module checks after
      changing the dependency graph. Include a desktop launch on macOS since the
      existing override also serves Electron.

## 3. Give the user a precise recovery instruction

- [ ] Add a small packaged helper beside `src/cli/bootstrap.mjs`. Run it after
      the Node check and before starting the application for production `serve`.
      Resolve drivers relative to their consumers. Open, query and close an
      in-memory database for each unique driver. Keep the existing
      source-checkout rebuild path and cheap help/version paths. Reuse the
      SQLite probe in `src/cli/application-update-installer.ts` where it
      currently checks only the top-level driver.
- [ ] On a confirmed native binding load error, identify the failed module,
      current Node and load error. For a verified npx cache entry, print
      `npm cache npx rm <actual-key>` and the command to relaunch. Verify the
      configured cache location, entry key and package identity. If the user
      supplied a custom cache, include that cache in the printed repair and
      relaunch commands. For npm versions lacking targeted removal, give a retry
      using a fresh private cache. For a global or local install, give recovery
      appropriate to that installation. Let the user run the repair after the
      launcher exits.
      [npm cache commands](https://docs.npmjs.com/cli/v11/commands/npm-cache/)
- [ ] Extend `src/cli/bootstrap.test.ts` with a fixture where the app driver
      opens and only the adapter driver fails. Assert a nonzero exit, a scoped
      recovery instruction and no user database creation. Cover a shared healthy
      driver, custom cache, unrecognized directory, unsupported Node and help.
      Verify a real migration error retains its migration diagnostic.
- [ ] In a disposable installed tarball, invalidate the test copy of the
      binding, run `serve`, execute the printed repair, and rerun. Require a
      healthy database and PTY. Check that an unrelated cache entry and a
      preexisting database sentinel survive recovery.

## 4. Establish the Node 24 floor and publish the quick start

- [ ] Determine the lowest Node 24 patch allowed by the installed production
      dependencies and runtime APIs. Use a candidate package with a provisional
      gate on the implementation branch, so the existing 26.8.1 check does not
      predetermine the result. Test the candidate floor and a current patched
      Node 24, then the existing 26.8.1 minimum and development pin. Include
      cold installs on macOS and Linux and the 24-to-26 cache reuse case.
      Exercise Windows separately with a Windows shell for the PTY and recovery
      checks before claiming that coverage.
- [ ] Once the matrix passes, advertise the verified 24.x range alongside the
      existing `>=26.8.1` range. A blanket lower bound also admits Node 25 and
      previously untested early Node 26 releases. Adapt the current
      single-minimum representation in `.node-minimum`, the bootstrap,
      `src/cli/setup-prerequisites.mjs`, `src/cli/node-runtime.ts`, package
      engines and workflow consumers together. Test the exact floor, the patch
      below it, Node 25, 26.8.0, 26.8.1 and prereleases. Use the same acceptance
      rules in both launch checks and keep the bootstrap usable on an older
      Node.
- [ ] Update the minimum-runtime CI job in `.github/workflows/ci.yml` and its
      assertions in `scripts/ci-workflow.test.ts`. Build and run contributor
      checks with the pinned toolchain. Run the packed consumer tests on the
      promised runtimes. Make those results a prerequisite for staging the
      tested tarball.
- [ ] Put two equally visible choices at the top of `README.md` Quick Start.
      Link the current macOS desktop release with its OS requirement and bundled
      runtime. Show `npx factory-factory@latest serve` with the verified Node
      range. Separate prerequisites to launch from optional account and
      integration setup. Update the runtime policy in `CONTRIBUTING.md` and
      `docs/distribution-security.md`.

**Acceptance.** On a clean machine the published CLI serves the UI, completes a
database query and opens a terminal. The same installation passes after a
supported Node switch. A broken native binding produces an actionable repair
before migrations, and following that repair restores the launch. The macOS
quick start also offers a path that requires no system Node installation.

**Implementation verification.** Follow the repository's contributor checks,
including `pnpm check:fix`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` and `pnpm check`. Record packed-consumer results by OS,
Node, npm and cache state. Exercise the npm publish workflow in dry-run mode
before shipping.
