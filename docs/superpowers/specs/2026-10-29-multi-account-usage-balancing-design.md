# Multiple provider accounts and usage balancing

Date: 2026-10-29

Status: Codex-only MVP implemented on `codex/codex-accounts`. The broader Claude
and generated-handoff sections remain future design.

## Intent and agreed scope

Martin wants Factory Factory to balance usage across multiple Claude and Codex
accounts. Balancing new conversations and an explicit handoff are enough for the
first version. Seamless account switching inside an existing conversation is not
required.

The recommendation is a moderate feature built on isolated provider profiles and
account-aware session creation. FF already starts separate ACP subprocesses, so
it does not need another provider harness or a model request proxy.

The choices below are proposed engineering defaults unless identified as agreed
scope. They can be adjusted before implementation.

## Codex-first MVP and feasibility test

Start with Codex. Its compatible native runtime is already bundled with FF, and
FF already reads account and quota information from its app-server. Claude adds
another login/runtime alignment question because current health/login tooling
uses the PATH CLI while ACP and usage probes use packaged dependencies. Both
providers have documented profile isolation; this is an FF implementation-cost
judgment, not a claim that Claude cannot support multiple accounts.

The smallest usable product MVP is Codex-only: two named profiles, native
sign-in, usage per profile, Auto/manual selection for new conversations, and a
durable account binding through stop/resume and history browsing. Auto can begin
with the least-pressure policy above and active-start reservations. Keep a
manual override. Defer Claude, polished handoff generation, cross-account native
migration, and advanced balancing controls. The first release must still handle
every enabled Codex creation/resume path consistently; hiding account selection
in an automated path is not sufficient isolation.

Before implementing those product surfaces, run a disposable two-account spike:

1. Create two private homes with native per-home file credential storage. Have
   Martin independently authenticate his two accounts without copying token
   files.
2. Use FF's bundled Codex to verify distinct native account identities and read
   quota separately. Suppress identity details and native stderr from probe
   output.
3. Run two concurrent short marker prompts through FF's actual ACP client, with
   a separate factory/environment per test profile and a shared empty work
   directory.
4. Stop both provider processes, recreate them with the same profile and exact
   native conversation ID, and confirm each recalls only its own marker.
5. Verify account identities are unchanged after the run. Report native
   isolation separately from product functionality: a passing spike does not
   implement or prove FF's account picker, persisted account resolution, history
   loader changes, balancing, forced token-refresh behavior, or logout
   isolation.

The spike submits only bounded no-tool prompts and changes no production code.
Its private profiles remain outside the repository. Live testing requires both
browser sign-ins; an unsigned-profile preflight alone cannot establish success.

### Observed Codex results

The live spike passed on Martin's Mac on 2026-10-29 at 4:37 p.m. Eastern, using
Codex ACP 2.3.0 and its bundled Codex 0.164.0:

- Two independently signed-in profiles reported distinct native account
  identities.
- Both profiles returned account-level quota data in separate app-server probes.
- Two simultaneous conversations answered separate marker prompts through FF's
  actual `AcpClientFactory`, each with its own fixed environment.
- After both provider processes stopped, newly created processes resumed the
  original native conversation IDs and recalled their respective markers.
- Both profiles retained their original account identity after the run.

The test used isolated `CODEX_HOME` directories and native file credential
storage, not copied credentials. Raw identities, credentials and native stderr
were excluded from probe output and the result report. Four short model prompts
ran in total. The native runtime, account/usage endpoints and FF ACP client were
real; the FF database/UI/account resolver and application-level history loader
were not under test. Provider-process restart was tested; a full FF backend
restart was not.

Device-code login encountered an account setting requiring explicit enablement.
Native regular browser OAuth succeeded for both accounts without changing that
setting. Prefer regular browser login for the local MVP, with device-code login
as an available alternative when enabled. Run interactive browser logins
sequentially because the tested native flow uses a fixed localhost callback
port.

Native keyring isolation, forced token refresh, logout isolation, Claude and
other platforms remain unverified. These results establish feasibility of the
Codex file-profile approach; they do not establish those additional properties.

## Product behavior

- Settings lists named accounts under each provider, with login status, usage
  windows, reset times, and an enable-for-balancing toggle. Login and re-login
  use the native provider's supported flow in that profile.
- New conversations offer Auto or a named account. Auto balances only within the
  chosen Claude or Codex provider and checks compatibility with the chosen
  model.
- A conversation displays its selected account and keeps that account through
  prompts, stop/resume, backend restart, browsing, native subagents, and
  automated updates to that conversation. Changing the default affects future
  conversations.
- On an exhausted account, preserve the composer/queued prompt and existing
  error evidence. Offer wait-until-reset or Continue with another account. Do
  not replay an ambiguous failed prompt automatically.
- Continue with another account creates a distinct conversation in the same
  workspace. The user chooses the destination account or Auto and reviews an
  editable handoff before sending. Keep the old conversation and link the two.
  Explain that the new model receives only the submitted handoff, not the
  original native conversation or its hidden reasoning/tool state.
- First-version handoff is deterministic and editable: reference the source
  conversation, workspace/branch, latest user request and a bounded excerpt of
  visible recent messages. Explicitly identify omitted history and attachments;
  attachments are not silently carried over. No inference call on the exhausted
  account is required to prepare it. User-added summaries are ordinary text.

## Provider support and first validation

Official documentation supports the basic isolation mechanism:

- [Codex state locations](https://learn.chatgpt.com/docs/config-file/config-advanced)
  places configuration and local state under `CODEX_HOME`.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) supports file,
  keyring, auto and ephemeral credential stores. With file storage, credentials
  live under `CODEX_HOME`. Managed authentication requirements can constrain
  this.
- [Claude configuration](https://code.claude.com/docs/en/env-vars) explicitly
  describes `CLAUDE_CONFIG_DIR` for running multiple accounts side by side.
- [Claude credential management](https://code.claude.com/docs/en/authentication)
  says credentials and macOS Keychain entry identities follow that directory.

Documentation describes current upstream behavior. Validate FF's actual pinned
adapters and SDK before promising compatibility: Codex ACP 2.3.0, Claude ACP
dependency ^0.98.0, and Claude SDK 0.3.310. The installed Claude adapter already
resolves its configuration directory from `CLAUDE_CONFIG_DIR`.

Time-box the first investigation to 1–2 engineering days:

1. Use two independently authenticated profiles per provider on macOS. Verify
   account identity, concurrent sessions, quota probes, native resume and
   history after restart. Never print tokens or read credentials into the UI.
2. Verify Codex keyring namespacing for the packaged runtime; if unsupported,
   use native per-profile file storage where allowed. An enforced incompatible
   policy reports unsupported setup instead of silently sharing a credential
   store.
3. Verify Claude login uses a compatible runtime and the same directory as ACP
   and SDK probes. Decide whether the existing PATH Claude CLI can serve login
   or a packaged entrypoint is necessary.
4. Exercise refresh, logout, cancelled login and simultaneous profile use.
   Confirm logging out of one isolated profile does not change another.
5. Verify identity fields and quota/model signals actually available for each
   provider. Unknown identity/usage must stay visibly unknown.

Run Windows/Linux contract and filesystem tests in CI, with live account smoke
checks before declaring those platform combinations supported. A manual smoke
check requires real accounts and must never consume model turns merely to read
quota. The Codex smoke results above cover the tested macOS file-profile setup;
the broader compatibility investigation remains incomplete.

## Historical implementation seams before the Codex MVP

These observations describe the code before implementation. The Codex MVP now
persists account bindings and scopes runtime, history, discovery and usage to
the selected account; see
[agent runtime](../../architecture/agent-runtime.md#codex-accounts) for current
behavior. The Claude integration remains a future extension.

- `prisma/schema.prisma`: `AgentSession` stores provider and native conversation
  identity but has no account binding. `UserSettings` stores provider/model
  defaults without accounts.
- `src/backend/services/session/service/acp/acp-client-factory.ts`: each adapter
  inherits the shared environment; `AcpClientOptions` has no profile context.
- `src/backend/services/session/service/lifecycle/provider-usage.service.ts`:
  cache and in-flight reads are keyed only by provider, with a 30-second TTL.
- `src/backend/services/session/service/acp/codex-plan-usage-loader.ts`: already
  calls account and quota APIs, but deliberately discards account identity
  fields.
- Claude and Codex model catalogs and the launch-options probe start independent
  provider processes and also need the account context.
- Native history loaders assume one global Claude/Codex home. CLI auth checks,
  discovery, cached global commands and `ff codex login` share that assumption.
- Session creation defaults are centralized in
  `session-provider-resolver.service.ts`; automatic launch paths must ultimately
  use the same account resolution policy.

## Account and session model

Add a provider-account capsule owning `ProviderAccount` persistence, profile
resolution, identity/status reads and native login lifecycle. Declare its public
barrel/dependencies and single Prisma writer in the service registry.

Proposed account fields: id, provider, label, profile kind (`native_default` or
`managed`), enabled-for-balancing, optional verified provider subject/workspace
identity, identity revision and timestamps. Store metadata, never OAuth tokens,
in Prisma. Status/usage observations may be cached rather than durable counters.

Managed profile directories use opaque IDs under FF's application data
directory, outside repositories. Restrict directory access and leave credential
persistence and refresh to the native provider. Do not copy or synchronize live
token files. Use the same resolved home/store for login, active runtime,
discovery and probes.

The native-default profile points to the configured existing provider home and
preserves current behavior. Existing sessions migrate to that profile; do not
assume a new managed profile can resume their native history. The current global
`CODEX_SESSIONS_DIR` override remains specific to the legacy default unless an
explicit supported per-profile override is added.

Add a provider-compatible `providerAccountId` to `AgentSession`, indexed and
immutable after creation. Treat it as part of the durable native conversation
identity. Disable/delete requests retain a tombstone while conversations
reference the profile; removing an account never silently deletes native
history. Disabling for balancing prevents new Auto assignments and leaves
existing bindings usable. Logout is a separate explicit operation and reports
affected running sessions.

Verify account identity on login/re-login and before a new runtime is admitted,
where native status APIs support it. A changed verified subject/workspace cannot
resume an old binding silently. Offer reauthentication of the original identity
or a new conversation. Where identity cannot be verified, label that limitation
and make re-login to a different identity create a new profile.

Keep one identity revision per profile so late usage/catalog results from a
previous login cannot repopulate current caches. Deduplicate verified profiles
that share a quota identity; two logins for one account do not imply two
budgets. Exact identity/budget grouping depends on the compatibility
investigation.

## Resolve context once and carry it everywhere

A server-only resolved context contains provider, account ID, identity revision,
native home, credential-store policy and history location. Construct environment
values through configService and a shared provider-environment builder. Pass
that context explicitly into runtime spawn and every disposable probe; never
mutate the backend's environment or reconfigure a global factory between
sessions.

Managed subscription profiles remove conflicting inherited authentication or
provider-routing overrides, such as API-key/OAuth-token variables, according to
each runtime's precedence. Validate the resolved setup before launch. Preserve
legacy environment behavior for the native-default profile. Arbitrary cloud/API
credential profiles are outside this first version.

Use account ID + identity revision for quota/catalog/auth/launch-option cache
keys and for in-flight request coalescing. Scope command and history discovery
to the profile too. No cross-profile fallback for missing native history or
failed auth; these errors must not activate the current default or ordinary
resume-fallback repair. Preserve existing fallback semantics only inside a valid
same-account binding where the existing lifecycle contract allows them.

New isolated homes also isolate user settings, plugins, skills and memory.
Explain this when adding an account and allow deliberate import of non-secret
preferences later. Do not symlink entire existing homes or promise identical
global tools. Repo-local configuration continues to apply normally.

## Balancing policy

Start with a deterministic least-pressure policy. Do not attempt to calculate
remaining tokens from percentages or compare Claude budgets to Codex budgets.

1. Filter accounts by requested provider, enabled state, verified usability,
   requested model availability and any explicit workspace restriction.
2. Coalesce usage reads with the existing 30-second cache. Refresh stale
   readings within a bounded startup deadline; unknown readings are never
   treated as 0%.
3. Compare the most constrained applicable short-term, weekly and model-specific
   quota windows. Accounts at a known hard limit are ineligible until refresh or
   reset. Use configurable headroom to avoid assigning work at the cliff.
4. Prefer lower pressure with sufficient headroom. Break near ties by active
   assignments/startup reservations and then least-recent assignment. Parameters
   and ties are builder choices to validate in tests; expose a simple reason in
   the UI rather than a misleading precision score.
5. Atomically reserve an assignment inside the backend before launching, so many
   concurrent workspace starts do not all choose the same cached best account.
   Track startup leases and active work; release on startup failure, settled
   work, runtime exit/stop and shutdown, with restart recovery. A long-idle
   conversation does not permanently count as active work. This is a scheduling
   estimate, not a provider quota reservation or exact token accounting.
6. If quota is unavailable, allow an authenticated compatible account only as a
   clearly labeled fallback with concurrency/rotation selection. If every
   account is known exhausted, wait or show the earliest useful reset; never
   cycle logins or silently send the prompt to a different provider. An explicit
   account choice is retained; quota warnings can be shown without silently
   changing its identity.

On a known account-limit response, invalidate quota, apply a bounded cooldown
and offer handoff for that conversation. Distinguish auth failure, model access
and transient network errors; do not mark every failure as account exhaustion.

This scope assumes one FF backend owns a managed profile store. Coordination of
assignment counts across multiple FF servers is deferred. Native runtime token
refresh behavior with concurrent sessions must pass the initial investigation.

## Every launch path follows an explicit rule

- Human-created conversations: explicit account or Auto under the chosen
  provider.
- Native subagents: inherit their parent runtime's account.
- Agent-created child workspaces: resolve Auto for their chosen provider,
  allowing new work to spread across accounts; an explicit user account
  restriction wins.
- Scheduled tasks, quick actions, reviewer sessions and a new dedicated
  PR-update conversation: resolve through the same new-conversation account
  policy.
- Further PR updates/notifications/reviewer continuation to an existing
  conversation: preserve that conversation's account.

Workspace restrictions/defaults are optional additive settings; Auto is the
recommended new-conversation choice after multiple usable accounts are
configured. Single-account installations retain their existing behavior and
extra UI stays compact. GitHub, Linear and repository git identities are
unaffected.

## Rollout and reviewable slices

1. **Compatibility evidence:** disposable two-profile smoke checks and a brief
   result for each supported platform/runtime. Stop and revise if isolation
   fails.
2. **Profile plumbing:** capsule/schema/migration, legacy bindings, per-session
   environment/history resolution, manual account selection and native
   login/status CLI support. Include profile context in all probes before
   shipping concurrent managed profiles.
3. **Balancing:** per-account usage/model/auth caches, selection reason, startup
   reservations, activity accounting, cooldowns and all launch-path integration.
4. **User flow and handoff:** settings/account picker, usage display, queue-safe
   exhaustion handling, editable handoff and linked replacement conversation.
5. **Hardening and delivery:** lifecycle races, identity changes, Windows
   packaging, migration/rollback, docs and normal repository checks. Review the
   final diff through Cubic under the existing standing authorization.

Engineering estimate, not measured delivery time: 1–2 days for compatibility;
roughly 1–2 weeks total for a focused version if the native flows work as
documented. Allow 2–3 weeks for cross-platform polish and robust recovery. An
adapter upgrade or newly discovered credential-store incompatibility changes the
estimate.

## Verification and acceptance

Focused tests must establish:

- Two accounts of each provider run concurrently without environment,
  credential, history, command, catalog or usage-cache crossover.
- Restart/resume and history browsing use the saved account after defaults
  change.
- Legacy migration leaves existing native conversations usable and is
  repeatable.
- Model-specific limits and account eligibility influence selection correctly;
  unknown and stale usage do not appear as unused quota.
- Burst creation spreads assignments; failed/cancelled startups release leases;
  stop/exit/shutdown/restart do not leak active assignment counts.
- Re-login invalidates caches, rejects stale observations and cannot silently
  change the identity of a bound conversation. Account removal preserves
  history.
- All launch paths obey the stated account policy, including scheduled work,
  reviewer sessions, native subagents, child workspaces and PR updates.
- Explicit handoff creates a distinct linked session, preserves the old
  transcript and draft, identifies missing context/attachments and submits only
  after user review. A failed attempt with uncertain provider receipt is not
  auto-replayed.
- Remote/untrusted clients cannot browse arbitrary profile paths, start login or
  read secrets. Existing trusted-local usage restrictions also protect account
  management. Zod validates transport and native response boundaries.

Run targeted Vitest suites while developing, then the CONTRIBUTING.md
verification matrix for schema, backend and UI changes: generation/migration
drift checks, typecheck, pnpm check, relevant integration/full tests and
UI/production builds as required. Render settings, account selection and
exhausted-account states in Storybook and validate keyboard/screen-reader
behavior. Run real-provider checks only with explicitly configured test
accounts; never imply mocked tests establish native login isolation.

Success: with two usable accounts for one provider, new conversations distribute
according to reported capacity, existing ones keep their original account across
restart, and a limited conversation can start a clearly identified handoff using
another account without losing the original conversation.

## Deferred

Seamless native conversation migration, automatic replay after a partial tool
turn, cross-provider fallback, quota purchasing, exact token-budget accounting,
cloud credential syncing, arbitrary API/cloud-provider profiles and multi-server
scheduling are separate follow-up work. No implementation is included here.

## Implementation verification

The Codex-only implementation supports Native default plus any number of added
managed profiles, trusted-local native browser login, per-account usage,
Auto/manual new-conversation selection, immutable saved bindings, account-scoped
discovery and local history, and version 7 backup account metadata.
Native-default reconnection remains a native CLI operation; managed re-login is
staged and verified before credential adoption.

Final verification: 8,772 full-suite tests passed (3 opt-in provider tests
skipped), 211 integration tests passed (3 opt-in tests skipped), and all 3
mobile browser checks passed. Type, lint, ownership, environment, foreign-key
and import checks passed. Production and Storybook builds passed. Cubic and
independent reviews were completed; material findings were fixed and verified
with focused regressions.

The implemented native identity/usage/model probes also passed against Martin's
two isolated signed-in profiles without model turns. Native browser-login
startup, pending-runtime fencing and cancellation passed against the actual
bundled runtime without completing another sign-in or adopting credentials. The
earlier live concurrent-prompt and exact-resume spike remains the real-provider
conversation evidence. Windows executable layout has contract tests against the
pinned wrapper; live Windows OAuth and keyring-only workspace identity are not
verified.
