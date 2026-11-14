# Codex accounts capsule

The ChatGPT accounts Codex sessions run under: the Native default (the user's
own Codex home) and managed profiles that Factory Factory creates, their
identity, sign-in, plan usage, Auto selection, and the account metadata in a
data backup. The [services guide](../AGENTS.md) covers capsule layout and
boundaries. `index.ts` and paths that start with `service/` or `resources/` are
relative to this directory, other bare file names are under `service/`, and
paths that start with `src/` are from the repository root.

## Owns, and does not own

The capsule owns the Prisma model `CodexAccount` (through
`resources/codex-account.accessor.ts` and, for backups,
`resources/codex-account-backup.accessor.ts`), each account's private profile
directory under the application data directory, the pinned identity, browser
sign-in, the native probes that read identity, models and quota, and the choice
of account for Auto. Codex stores the credentials itself, in the profile. It
does not own:

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
- Bundled Codex health and the recovery guidance it shows:
  `src/backend/orchestration/cli-health.service.ts`,
  `src/backend/lib/codex-provider-errors.ts`.

## Public surface

`index.ts`: the singleton `codexAccountService` and its class
`CodexAccountService` (`getAccounts`, `createAccount`, `updateAccount`,
`getUsage`, `getRuntimeContext`, `getHistoryContext`,
`getPreviewRuntimeContext`, `withAccountReservation`, `getEnabledAccountIds`,
the login methods and `shutdown`), the type `CodexRuntimeContext`,
`NATIVE_DEFAULT_CODEX_ACCOUNT_ID`, `getMetadataCredentialsStore`, and the backup
functions `exportCodexAccountMetadata`, `restoreCodexAccountMetadata` and
`resolveRestoredCodexAccountId`.

## Invariants

- Auto picks only an enabled, signed-in account that supports the requested
  model and reasoning effort and whose quota is not known to be exhausted, and
  prefers known remaining quota to unknown; an explicit choice may use a
  disabled account. `codex-account.service.test.ts`.
- When Auto has no candidate, an identity failure is reported as such, and
  otherwise a failed probe reports the retry message, not exhausted quota.
  `codex-account.service.test.ts`, `review-regressions.test.ts`.
- Concurrent Auto requests are spread over accounts of similar quota pressure by
  their open reservations and most recent assignment.
  `codex-account.service.test.ts`.
- An account keeps the identity first verified for it: a later read of another
  identity fails instead of rebinding, except that a Native default email
  fallback may upgrade to the verified scope of the same email.
  `codex-account.service.test.ts`, `review-regressions.test.ts`.
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
- A native probe that fails or outlives its deadline reports the retry message,
  and at most four native processes run at once. `native-rpc.test.ts`,
  `native-slots.test.ts`.
- Restoring a backup reuses a local account only for a verified matching
  identity and otherwise adds a managed profile that needs sign-in, never
  mapping an imported Native default onto this machine's login.
  `codex-account-backup.test.ts`.

## Map

- `codex-account.service.ts`: `CodexAccountService`, identity pinning, Auto
  candidates and reservations; `account-selection.ts`: quota pressure and the
  choice.
- `profile.ts`: profile directories and their environment; `profile-trust.ts`:
  project trust inheritance.
- `native-account.ts`, `native-rpc.ts`, `native-slots.ts`: probes and sign-in
  through the bundled Codex app server; `normalize-usage.ts` re-exports the
  quota normalizer from `src/backend/lib/codex-usage-normalizer.ts`.
- `identity.ts`: Native default email fallback keys.
- `login-coordinator.ts`: the one browser sign-in.
- `metadata-credentials-store.ts`: the credential store a disposable inference
  process inherits.
- `codex-account-backup.ts`, `resources/codex-account-backup.accessor.ts`:
  backup metadata.
