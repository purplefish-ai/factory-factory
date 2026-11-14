# Codex accounts capsule

The ChatGPT accounts Codex sessions run under: the Native default (the user's
own Codex home) and managed profiles Factory Factory creates, with their
identity, sign-in, plan usage, Auto selection and backup metadata. The
[services guide](../AGENTS.md) covers capsule layout and boundaries. `index.ts`
and paths that start with `service/` or `resources/` are relative to this
directory, other bare file names are under `service/`, and paths that start with
`src/` are from the repository root.

## Owns, and does not own

The capsule owns the Prisma model `CodexAccount` (through
`resources/codex-account.accessor.ts` and, for backups,
`resources/codex-account-backup.accessor.ts`), each managed account's private
profile directory, the pinned identity, browser sign-in, the native probes that
read identity, models and quota, and the choice of account for Auto. Codex
stores the credentials itself, in the profile. It does not own:

- Which account a session uses once created, and resolving it at startup and for
  history: the session capsule (`src/backend/services/session/`, its `data/` and
  `lifecycle/` modules).
- Per-account model catalogs and launch options: the session capsule's
  `providers/` module and `config/launch-options/`.
- The account procedures and their trusted-local-client check:
  `src/backend/trpc/codex-accounts.trpc.ts`.
- Export and import of whole backups: `src/backend/orchestration/data-backup/`.
- The settings page, pickers and sign-in dialog:
  `src/client/features/codex-accounts/`.
- Bundled Codex health and its recovery guidance:
  `src/backend/orchestration/cli-health.service.ts`,
  `src/backend/lib/codex-provider-errors.ts`.

## Public surface

`index.ts` exports `codexAccountService`, its class `CodexAccountService`,
`CodexRuntimeContext`, `NATIVE_DEFAULT_CODEX_ACCOUNT_ID`,
`getMetadataCredentialsStore` and the backup functions.

## Invariants

- An Auto reservation picks only an enabled, signed-in account that supports the
  requested model (unless it reports no model list) and reasoning effort and
  whose quota is not known to be exhausted, and prefers known remaining quota to
  unknown; an explicit choice may use a disabled account, and the launch options
  preview may use an exhausted one. `codex-account.service.test.ts`,
  `review-regressions.test.ts`.
- Auto skips an account whose browser sign-in is pending, however low its quota
  pressure. `codex-account.service.test.ts`.
- When Auto has no candidate, an identity failure is reported as such, and
  otherwise a failed probe reports the retry message, not exhausted quota.
  `codex-account.service.test.ts`, `review-regressions.test.ts`.
- Concurrent Auto requests are spread over accounts of similar quota pressure by
  their open reservations and most recent assignment, and a reservation is
  released when its callback returns or fails. `codex-account.service.test.ts`.
- An account keeps the identity first verified for it: a later read of another
  identity fails instead of rebinding, except that a Native default or a staged
  managed login may upgrade an email fallback to the verified scope of the same
  email. `codex-account.service.test.ts`, `review-regressions.test.ts`.
- No two accounts share an identity, the Native default included, since the same
  login adds no quota; a missing saved account never falls back to the Native
  default. `codex-account.service.test.ts`.
- One browser sign-in runs at a time, since Codex's callback uses a fixed local
  port; cancelling it frees the port. `codex-account.service.test.ts`.
- A managed profile uses file credentials (a keyring setting is rejected) and
  drops inherited `OPENAI_`, `CODEX_` and other provider or authentication
  overrides from its environment. `codex-account.service.test.ts`,
  `review-regressions.test.ts`.
- Preparing a managed profile for use, so linked worktrees load repository
  configuration under every account, copies only the project trust levels it
  lacks from the Native default's `config.toml`, keeps its own entries, and
  never writes the native file; creating an account does not read it, so a bad
  native file cannot fail a persisted account's creation.
  `profile-trust.test.ts`, `profile-trust.integration.test.ts`,
  `review-regressions.test.ts`.
- A native probe that outlives its deadline, or waits too long for a process
  slot, reports the retry message instead of native error text, and at most four
  native processes run at once. `native-rpc.test.ts`, `native-slots.test.ts`.
- Restoring a backup reuses a local account only for a verified matching
  identity and otherwise adds a managed profile that needs sign-in, never
  mapping an imported Native default onto this machine's login.
  `codex-account-backup.test.ts`.

## Hazards

Not verified against real accounts: keyring credentials, and Codex token refresh
and logout staying within one profile.

## Map

- `codex-account.service.ts`: identity pinning, Auto candidates and
  reservations; `account-selection.ts`: quota pressure and the choice.
- `profile.ts`: profile directories and their environment; `profile-trust.ts`:
  project trust inheritance; `identity.ts`: Native default email fallback keys.
- `native-account.ts`, `native-rpc.ts`, `native-slots.ts`: probes and sign-in
  through the bundled Codex app server; `login-coordinator.ts`: the one browser
  sign-in; `metadata-credentials-store.ts`: the credential store a disposable
  inference process inherits.
- `codex-account-backup.ts`, `resources/codex-account-backup.accessor.ts`:
  backup metadata.
