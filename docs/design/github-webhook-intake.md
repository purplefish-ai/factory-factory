# Design Note: GitHub Webhook Intake for Event Automations

> **Status:** Proposed. Nothing here is implemented. GitHub event automations
> poll the repository issue-events feed, and that remains the shipped intake.
> Written 2026-11-12 for
> [#2772](https://github.com/purplefish-ai/factory-factory/issues/2772) as the
> starting point for a later implementer. It lays out options and a
> recommendation; it does not schedule work.

## Summary

Polling ships first because it needs nothing beyond the user's `gh` login. It
cannot see issue `opened` or `edited`, comments, reviews or CI, and it adds a
poll interval of latency and a steady API cost per repository. Webhooks fix
coverage and latency. In exchange, a local app has to expose a public HTTPS
endpoint, someone with repository admin has to register a hook, and the app has
to recover deliveries GitHub never retries. The
[recommendation](#recommendation) is per-repository hooks registered through the
existing `gh` login. Deliveries go to a webhook-only local listener behind a
stable tunnel the user runs. Webhooks carry only the actions polling cannot see,
so no real-world event ever has two identities.

## Why polling shipped first

The
[event-triggered agents plan](../superpowers/plans/2026-11-01-event-triggered-agents.md#scope-and-delivery-decisions)
chose authenticated outbound polling through `GitHubCLIService` to avoid a
public endpoint, a cloud relay and repository-admin hook installation. It reuses
the `gh:<repository-id>` connection, which is a repository identity, not a
GitHub App installation. The owner confirmed this choice in the
[finish design](../superpowers/specs/2026-11-12-finish-event-automations-design.md#decided-with-martin).

What polling captures (`agent-issue-events.ts`, `agent-runtime.ts`): it reads
`repos/{repo}/issues/events` 100 rows per page. Only issue (not PR) `labeled`
and `reopened` rows become executable `AgentEvent` payloads, with the issue's
labels as read at capture. GitHub records labels applied when an issue is
created as `labeled` events, so a labeled new issue already reaches automations.
A deleted actor or issue author arrives as a null user and is stored as a null
`actorId` or `creatorId`. Every other row, including PR rows and rows with no
issue, is kept only as a control anchor for ordering.

What polling cannot do:

- **Coverage.** GitHub's
  [issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)
  have no `opened` or `edited` type, so an issue opened without a label is
  invisible. `renamed` covers only title changes. `commented` and `reviewed`
  exist only in the timeline API, not the repository feed. The feed has no CI
  events. It does carry some PR lifecycle rows (for example `labeled`,
  `merged`), but intake treats every PR row as a control anchor, so no PR
  trigger exists.
- **Latency.** The `agent-source-poll` job waits 60 seconds after each cycle and
  reads at most ten pages per repository per cycle, so a backlog takes several
  cycles
  ([background jobs](../architecture/background-jobs.md#timer-dispatch-ownership)).
  Evaluation then runs on its own five-second cadence.
- **Cost.** Each cycle reads the repository identity for each configured project
  path and at least one events page. That is two or more requests per repository
  per minute, about 120 an hour. Every other `gh` user in the app, such as PR
  monitoring and reviews, draws from the same 5,000-request hourly
  [authenticated limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Receiving deliveries on a local machine

GitHub delivers to a public HTTPS URL and expects a 2XX within 10 seconds, or it
records a failure
([handling deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries)).
The backend normally listens on loopback, so something has to bridge the two.

### Exposure options

| Option                                                                                                                                                 | What the user needs                                                                                                                                                                 | Stable URL                                                                                                       | Fit                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [cloudflared quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) | `cloudflared` only; no account                                                                                                                                                      | No: a new `trycloudflare.com` hostname every run, so the hook URL must be updated (with admin rights) each start | Development only; Cloudflare calls quick tunnels testing and development                  |
| [cloudflared named tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)   | Cloudflare account and a domain added to Cloudflare                                                                                                                                 | Yes                                                                                                              | Good for users who already run Cloudflare                                                 |
| [ngrok](https://ngrok.com/docs/universal-gateway/domains/)                                                                                             | ngrok account; every account, including free, gets one dev domain                                                                                                                   | Yes: the dev domain survives restarts                                                                            | Lowest-friction stable option                                                             |
| [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)                                                                                               | Tailscale 1.38.3+, MagicDNS and HTTPS enabled, a `funnel` node attribute in the tailnet policy, approval; ports 443, 8443 or 10000 only; bandwidth limits that cannot be configured | Uses the machine's `*.ts.net` name; the page does not state how long it stays valid                              | Good for existing Tailscale users; see below                                              |
| [`gh webhook forward`](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing)  | `gh extension install cli/gh-webhook`                                                                                                                                               | Not applicable                                                                                                   | No: GitHub says it is not supported in production; one forwarder per repository at a time |
| [smee.io](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events)    | Nothing                                                                                                                                                                             | Yes                                                                                                              | No: GitHub says not to use it in production                                               |
| [Hosted relay](#hosted-relay)                                                                                                                          | Nothing beyond signing in to the relay                                                                                                                                              | Yes                                                                                                              | Best user experience, but needs a cloud service the product does not have                 |

What the repository already has:

- **cloudflared.** `ff proxy` and the run-script tunnel start quick tunnels
  (`startCloudflaredTunnel` in `src/shared/proxy-utils.ts`). They expose the
  whole app behind a password or a read-only gate
  ([README](../../README.md#install-and-run)). Do not reuse that path for
  webhooks: it changes hostname each run and exposes far more than one endpoint.
- **Tailscale.** `ff tailscale` and port sharing use foreground Tailscale Serve
  only, which is reachable inside the tailnet and not by GitHub. Both designs
  state "never use Funnel"
  ([access](../superpowers/specs/2026-10-30-tailscale-design.md),
  [port sharing](../superpowers/specs/2026-11-03-tailscale-port-sharing-design.md)).
  `src/backend/lib/tailscale-cli.ts` reads `AllowFunnel` only to detect port
  conflicts. Funnel support would therefore be new, would reverse a recorded
  decision, and could not share a port with the Serve listener `ff tailscale`
  holds (Tailscale does not allow Serve and Funnel on the same port).

### Hosted relay

A relay is a small hosted service with one stable URL per connection. It stores
each delivery and the local app pulls over an outbound connection, acknowledging
each delivery once it is stored locally. It can forward the raw body and headers
untouched. The app then verifies the signature locally, so the relay never needs
the hook secret. The relay's retention would cover offline periods that GitHub
itself does not retry (see [missed deliveries](#missed-deliveries)).

The cost: Factory Factory has no cloud service today. The
[cloud vision](factory-factory-cloud-vision/README.md) is still a proposal,
though it already includes a WebSocket relay. A relay means hosting,
availability, abuse limits, sign-in for each user, and a privacy statement.
Webhook bodies contain issue and PR text, which the relay would hold in
plaintext.

### Registration: repository hook or GitHub App

|                   | Repository hook                                                                                                                                                                                         | GitHub App                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can set it up | Repository owner or admin ([types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks)); at most 20 hooks per event type per repository                                                  | Organization owners. Repository admins can install it only for repositories they administer, only when the app asks for no organization or administration permission, and only if owners have not blocked this; members can only request ([installing](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party))    |
| Credentials       | The existing `gh` login: its default `repo` scope covers repository webhooks ([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)); secret generated locally | App private key and webhook secret. One shared Factory Factory app cannot ship its key to every install, so it implies a hosted service. Each user could instead register their own app with the [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), which returns `pem` and `webhook_secret` |
| URL               | One per hook; the app can update it ([repository webhooks API](https://docs.github.com/en/rest/repos/webhooks))                                                                                         | One webhook per app, fixed in app settings; cannot be deleted, only deactivated                                                                                                                                                                                                                                                                          |
| Recovery APIs     | List deliveries, redeliver and ping through the repository hooks API                                                                                                                                    | List and redeliver need an app JWT ([app webhooks API](https://docs.github.com/en/rest/apps/webhooks))                                                                                                                                                                                                                                                   |
| Permissions       | Hook subscribes to chosen events                                                                                                                                                                        | Issues read for `issues` and `issue_comment`; Pull requests read for `pull_request`, reviews and review comments; Checks read for check events; Actions read for `workflow_run` ([events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads))                                                                                 |
| Identity fit      | Matches `gh:<repository-id>`                                                                                                                                                                            | Needs an installation identity the connection model does not have today                                                                                                                                                                                                                                                                                  |

An organization hook covers every repository with one registration. It needs an
organization owner and the `admin:org_hook` scope. It is a later option and does
not change the design below.

### Security surface

- **Public endpoint.** Run a separate listener that accepts only
  `POST /github/webhook` with a body limit, and point the tunnel at it, never at
  the backend port. The app's own request gates (trusted-local checks, origin
  validation, `ff proxy` sign-in) do not apply to GitHub. The signature is the
  only authentication, so nothing but that one route should be reachable. Reject
  unsigned or wrongly signed requests before any database work, and rate-limit
  them.
- **Secret storage.** Generate a high-entropy secret for each hook and store it
  encrypted with `crypto.service.ts` (AES-256-GCM, key in `encryption.key`) in
  `AgentConnection.credentialsEncrypted`. GitHub connections store no credential
  there today. Like Slack tokens, it never appears in reads, logs or logical
  export. A restored database without `encryption.key`, or a logical import,
  means rotating the secret on the hook.
- **Signature verification.** Compute HMAC-SHA256 over the raw body with the
  secret. Compare it with `X-Hub-Signature-256` using `crypto.timingSafeEqual`
  before parsing
  ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
  First require the header to be `sha256=` followed by exactly 64 hex
  characters, and answer 401 otherwise: `timingSafeEqual` throws on buffers of
  unequal length. Ignore the legacy SHA-1 header.
- **Replay.** The signature covers only the body. It has no timestamp, and
  headers, including `X-GitHub-Delivery`, are not signed. Anyone holding a
  captured request can replay the body under a fresh delivery ID, so delivery ID
  deduplication alone does not stop replay. Also store a SHA-256 digest of the
  body, unique per connection and retained as long as the event identity (90
  days), and treat a match as a duplicate: acknowledge it and store nothing. The
  trade-off is that two real events with byte-identical bodies would collapse
  into one. That needs the same action, issue state, sender and
  second-resolution timestamps, for example a label removed and re-added within
  one second; the note accepts that loss. Then enforce the activation boundary
  [below](#ordering-and-the-activation-boundary). With TLS terminated at the
  tunnel, the tunnel provider sees plaintext. I did not confirm where Funnel
  terminates TLS. GitHub's `GET /meta` IP list
  ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks))
  helps only if the tunnel passes the client address through, so treat it as
  defence in depth.
- **Content.** As with polling, issue and PR text is task data, never
  instructions or configuration.

## Entering the existing pipeline

Webhooks become a second intake that writes to the same `AgentEvent` ledger
through `ingestEvent`. Evaluation, admission, launch and settlement do not
change.

### Normalized payload

Keep the bounded, versioned payload in `agentEventPayloadSchema`: title 4,096
characters, body 100,000 characters, at most 100 labels, and no raw provider
JSON. Issue actions fit the existing GitHub variant, including its nullable
`actorId` and `creatorId` for deleted accounts. PR, comment and CI events need
new variants, because the current one requires an `issue`. `ingestEvent` already
rejects a payload whose `repositoryId` does not match the connection's
`gh:<repository-id>`. The webhook body's `repository.id` provides that value.
The listener should also check that `X-GitHub-Hook-ID` is the registered hook
and that `X-GitHub-Hook-Installation-Target-ID` is the repository.

### Identity and duplicates

- Use `X-GitHub-Delivery` as `providerEventId`, namespaced (for example
  `delivery:<guid>`) so it can never collide with numeric issue-event IDs.
  GitHub keeps the same delivery ID on redelivery
  ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)),
  so a redelivery is a duplicate insert and is acknowledged.
- The same real-world `labeled` event seen by both intakes would get two
  identities: an issue-event ID from the feed and a delivery ID from the hook.
  Runs are unique per `(agentDefinitionId, eventId)`, so this would launch two
  workspaces, which the finish design names as an anti-goal. I found no
  documented field in the `issues` webhook payload that carries the issue-event
  ID, so the two cannot be reliably joined.
- Avoid this by construction: every (connection, action) has exactly one owning
  intake. The options are:
  1. **Partition by action.** Polling keeps `labeled` and `reopened`, and
     webhooks own only actions the feed does not have.
  2. **Switch the whole connection** to webhooks, retiring polling for it.
  3. **Doorbell.** A delivery for a polled action stores nothing and wakes the
     poll job early. The event still arrives through the feed with its
     issue-event ID. `jobRunner` has no wake method today, so this would need
     one.

  _Recommendation:_ 1, with 3 later if `labeled` latency matters.

### Ordering and the activation boundary

Polling's boundary is a provider-order ordinal. An event is eligible when its
`sourceOrder` is above the boundary's, and a null `sourceOrder` defers it as
`SOURCE_ORDER_PENDING` (`agent-runtime-guards.ts`). Webhook events would never
get a `sourceOrder`, so they cannot use this rule. Reusing the column would also
corrupt the poller's ordinal proof. GitHub documents no delivery order or
sequence number; none of the pages cited here gives an ordering guarantee.

Today `automation.enable` prepares one GitHub baseline per connection
(`AgentSourcePollService.prepareBaseline`, retained in `AgentSourceBaseline`)
and records its ID on each `STARTING` trigger's pending activation. The
`agent-source-poll` job then makes the trigger `ACTIVE` once that baseline has
an ordinal, or returns it to `PAUSED` with `SOURCE_ERROR`,
`SOURCE_RECOVERY_REQUIRED` or, after 30 minutes, `ACTIVATION_EXPIRED`
([enable and pause](../architecture/integrations.md#enable-and-pause)).

Slack's planned approach is the model for a push source. Enable shows a nonce; a
verified human message in each channel proves delivery and supplies a provider
`event_ts` boundary; candidates are held unevaluated while the generation is
`STARTING`
([event ingestion and identity](../superpowers/plans/2026-11-01-event-triggered-agents.md#event-ingestion-and-identity)).
The GitHub equivalent:

- Enable asks GitHub to ping the hook
  (`POST /repos/{owner}/{repo}/hooks/{id}/pings`). The stored ping proves the
  tunnel, the secret and the hook work end to end, with no noise in the
  repository. It does not prove each event type is subscribed; registration sets
  those. One ping serves every pending generation on the connection, because a
  hook is per repository, not per channel.
- The boundary is the ping's position in a new monotonic local ledger sequence.
  `AgentEvent` has none today other than the GitHub-only `sourceOrder`.
  Deliveries committed after the ping are eligible. The pending-activation
  schema gains a webhook variant that waits for the ping instead of a
  `baselineId`, and the boundary schema gains one beside the polling boundary.
  The generation fence, the 30-minute expiry and the paused reasons stay as they
  are; a webhook ping that never arrives expires like an unresolved baseline.
- Commit order is not occurrence order. A late delivery, or a redelivery during
  catch-up, of something that happened before Enable would pass. Adding a floor
  on the payload's provider time (`created_at` or `updated_at`) relative to the
  pending activation closes most of that. It is a clock comparison that the
  Slack design deliberately avoids, so it is an
  [open question](#open-questions).

### Acknowledgement

Verify the signature, normalize, commit `ingestEvent`, then return 2XX, all
within GitHub's 10 seconds. Mirror the Slack contract:

- A duplicate insert is a success.
- Unsupported events or actions are acknowledged without storing content.
- A bad signature gets 401.
- A database failure gets 5xx, which GitHub records as a failed delivery for
  catch-up.

Ledger writes share a write lock with maintenance. Measure how long the lock can
be held and bound the wait so the 10-second limit holds; I did not check this.

### Missed deliveries

GitHub does not retry failed deliveries automatically. They can be redelivered
only for the past 3 days, by a repository admin for repository hooks or the app
owner for app hooks
([failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
[redelivering](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)).
While the app or tunnel is down, deliveries fail and stay failed.

- **Catch-up.** On start and periodically under `jobRunner`, list the hook's
  deliveries since the last check and redeliver those whose status is not OK.
  This goes through `GitHubCLIService` and needs admin rights. Redeliveries keep
  their delivery IDs, so this is idempotent.
- **Gaps.** Anything older than 3 days, or not recoverable without admin rights,
  is a visible delivery gap, like Slack's `gaps` cursor. It is never quietly
  skipped.
- **Polling's role.** Under option 1, polling stays the catch-up path for
  `labeled` and `reopened` only. It cannot backfill `opened`, `edited` or PR
  events because the feed does not contain them.

### Source health

`AgentSourceState` is keyed by connection, and its cursor is discriminated by
provider. A webhook intake needs its own state (a row per connection and intake,
or a webhook cursor variant) so that a tunnel outage does not mark polling
unhealthy, and the reverse. Signals: the last verified ping or delivery,
catch-up failures, signature failures, a hook missing from GitHub, and open
gaps. Reuse `agentSourceHealthSchema` states. `RECOVERY_REQUIRED` means a gap
that catch-up cannot close.

### Reset source

For polling, `automation.resetSource({ projectId, connectionId })` is accepted
only behind a `RECOVERY_REQUIRED` fence
([source reset](../architecture/integrations.md#source-reset)). In one ledger
transaction it pauses every trigger on the connection through the shared
`pauseTriggers` helper and cancels their queued runs. It then advances
`AgentSourceState.epoch` and clears the cursor, so the next Enable takes a fresh
baseline and events from the gap never run. Retained proof is never deleted. A
push source has no ordinal proof to fence, so reset becomes: accept the recorded
gap, pause that intake's triggers, cancel their queued runs, optionally rotate
the secret or re-register the hook, and require Enable again, which takes a
fresh ping boundary. Stored but unevaluated deliveries stay ineligible because
their generation is stale. Today `automation.resetSource` pauses every trigger
on the connection. With two intakes it should probably act per intake; see the
[open questions](#open-questions).

## Triggers webhooks unlock

Every row needs changes in four places:

- **Matcher.** `agentGithubExecutableActions` currently serves both capture and
  matching, so each intake needs its own list.
- **Capability.** A reason such as "webhook not set up for this repository"
  replaces `UNSUPPORTED_GITHUB_ACTION`.
- **UI copy.** The current wording is "Only GitHub labeled and reopened events
  are supported."
- **Authoring guidance** (`src/backend/mcp/automation-authoring-tools.ts`).
  `propose_automation` now offers only `labeled` and `reopened`, notes that
  `labeled` covers labels applied at creation, and says `opened` and `edited`
  are not yet supported. Webhook support would make that list depend on the
  repository's intake: offer `opened` (and later other actions) only where a
  verified hook exists, and steer away from pairing `opened` with a label filter
  and `labeled` in one automation. A labeled new issue produces both an `opened`
  delivery and a `labeled` feed row; they are different events, so that
  automation would run twice. `list_automation_sources` would also need to
  report whether each repository has a hook.

| Trigger                                                     | Webhook event                                        | Trigger schema                                             | Matcher and other needs                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue opened                                                | `issues.opened`                                      | Already allowed in `GITHUB_ISSUE.actions`                  | Label filter means labels at open time, like `reopened`. The natural first target, mainly for issues opened without a label; a labeled new issue is already caught by `labeled` (see authoring guidance above) |
| Issue edited                                                | `issues.edited`                                      | Already allowed                                            | Each edit is a separate event and could start a run. Needs a "what changed" filter (title or body) and probably a debounce rule before it is safe                                                              |
| Pull request (opened, labeled, ready for review, and so on) | `pull_request`                                       | New `GITHUB_PULL_REQUEST` trigger type and payload variant | New matcher and starting prompt; polling's PR rows remain control anchors                                                                                                                                      |
| Comment                                                     | `issue_comment`                                      | New trigger type                                           | Text filter; an automation's own comments would trigger it again, so it needs actor filters (rejected today as `UNSUPPORTED_ACTOR_FILTER`) or self-exclusion                                                   |
| Review or review comment                                    | `pull_request_review`, `pull_request_review_comment` | New trigger type                                           | Same loop risk; overlaps [PR monitoring](../architecture/pull-requests.md), which already delivers review feedback and CI failures to sessions that own the PR                                                 |
| CI                                                          | `check_suite`, `check_run` or `workflow_run`         | New trigger type                                           | Conclusion filter; same overlap with PR monitoring                                                                                                                                                             |

## Recommendation

_Recommendation:_ when webhooks are built, register a repository hook through
the existing `gh` login, deliver to a webhook-only local listener, and expose it
through a stable tunnel the user runs. Support ngrok's dev domain, a cloudflared
named tunnel, or Tailscale Funnel on 8443 or 10000, and use a quick tunnel only
in development. Webhooks own only the actions polling cannot see, starting with
issue `opened`. Polling keeps `labeled` and `reopened`. Webhook deliveries
follow Slack's push contract: acknowledge after commit, verify with a ping on
Enable, a local ledger-order boundary, and visible gaps. Startup redelivery
covers GitHub's 3-day window. Defer a GitHub App and a hosted relay until
Factory Factory has a cloud service. At that point a relay that forwards raw
signed deliveries is the better experience, and the local intake contract above
does not change.

## Open questions

1. Is asking users to run a tunnel and hold repository admin acceptable, or
   should webhooks wait for a hosted relay?
2. Should Factory Factory manage the tunnel process (as `ff proxy` does), or
   only accept a URL the user provides? Managing Funnel reverses the "never use
   Funnel" decision.
3. Should the push boundary add a provider-time floor, accepting clock skew, or
   rely on ledger order alone and accept that a late delivery from before Enable
   can run?
4. Should source reset act per intake when one connection has both?
5. Should `edited` and comment triggers wait until actor filters and
   self-exclusion exist?
6. Should webhook deliveries also wake PR monitoring, which polls today? That is
   outside this note's pipeline.

## Not confirmed

- Whether any webhook payload field links a delivery to an issue-event ID (none
  found).
- Delivery ordering guarantees (none documented on the pages read).
- `gh webhook forward` mechanics, flags and cleanup (the extension's README and
  GitHub's page do not say; the extension was not installed here).
- Where Tailscale Funnel terminates TLS, and how long a Funnel URL stays valid.
- How long the ledger write lock can be held under maintenance.
