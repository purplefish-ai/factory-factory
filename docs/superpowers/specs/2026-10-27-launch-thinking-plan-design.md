# Launch thinking and planning controls

The approved workspace mockup adds a compact thinking-level menu beside the
provider/model picker and replaces the Default/Plan dropdown with a Plan icon
toggle. Both controls use actual Claude and Codex capabilities. This record
captures that design; delivery requirements belong to the original task and PR.

Use the same controls for manual workspace creation, new conversations, and
Quick Chat. Keep provider-specific draft choices, saved defaults,
successful-creation reset, and existing-session navigation. Periodic-task
creation remains independent of chat defaults. Existing permission controls
retain their separate purpose.

Thinking options come from the selected native model, including levels beyond
Low/Medium/High when advertised. Discovery is disposable, submits no model turn,
rejects tool/permission callbacks, and closes its processes. Cache successful
results and coalesce requests for 30 seconds per provider/model. Unknown,
failed, and confirmed-unsupported capabilities are distinct. Failed discovery
offers Retry; stale results cannot replace a newer model's options.

Launch settings carry `reasoningEffort?: string | null` and
`planModeEnabled?: boolean`. Omitted effort inherits the saved provider default;
explicit null requests the native default; a string requests that exact
supported level. The initial control shows the effective saved/native selection.
Keep an explicit choice visible when a model change makes it unsupported, and
block creation until the user chooses a valid level or Default. Planning
availability also comes from native options; unsupported selected planning can
be turned off.

Persist explicit settings as validated session launch intent, without inventing
provider identities or configuration snapshots. Apply and confirm model,
thinking and Plan before releasing readiness or sending the first prompt. Plan
on uses Claude's native plan access mode or Codex's collaboration plan mode.
Plan off preserves the configured permission preset and never maps to a more
permissive legacy preset. Unsupported explicit choices or failed native applies
stop launch before prompting. Inherited unsupported defaults may use the native
default. Resume preserves the latest confirmed session configuration, rather
than reapplying stale launch intent or changed global defaults.

Test the actual components, startup and first dispatch, including the first
workspace prompt and no-prompt starts. Verify real Claude and Codex adapters in
disposable workspaces, checking supported options, explicit/default effort,
planning, and stop/resume. Run repository checks, full tests, integration tests,
both builds, mobile checks, and independent review before PR delivery.
