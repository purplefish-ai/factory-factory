# Conversational agent creation

Users describe an agent in a workspace conversation. The workspace agent uses
source discovery and proposal tools to produce a saved, structured proposal.
Chat renders the proposal as an editable widget with one **Create agent**
action. Conversation edits update that proposal using optimistic revision
checks. Acceptance atomically creates the definition and triggers exactly once.

The existing workspace agent performs natural-language interpretation. A shared
Zod contract, provider discovery, and relational validation constrain its
output. The widget and tools use the same authoring service. Persisted proposals
survive chat replay; old tool results load the latest proposal revision. No
credentials enter proposals or chat results.

The alternatives were a separate setup wizard and direct creation from a tool.
The selected approach uses the conversation for authoring and the widget for
explicit acceptance. No additional activation choice or mandatory preview step.

Proposals expose task instructions, event descriptions, semantic filters, and
resolved source settings. Sources must be actual accessible provider resources.
Preserve broad human-and-bot bug detection and thread context by default;
semantic filtering remains distinct from deterministic event selection.

The current event runtime is not implemented. Creation saves paused definitions
and triggers and says clearly that listening/dispatch is not active. This change
does not migrate PeriodicTask, install listeners, or implement classification.

Verification covers discovery, proposal persistence and revisions, exact-once
acceptance, invalid connections/resources, rendering outside collapsed tool
details, user edits, and the three agreed Slack/GitHub configurations. An opt-in
live authoring evaluation should exercise natural-language requests against a
controlled catalog; deterministic tests alone do not measure model quality.
