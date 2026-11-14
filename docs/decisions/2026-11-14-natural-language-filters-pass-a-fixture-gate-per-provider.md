# Natural-language filters pass a fixture gate per provider

Originally decided on 2026-11-12 in #3183 (issue #2772).

## Context

A trigger can carry `filterInstructions`, a natural-language filter that a model
judges for each event the trigger already matches. Event text is untrusted: an
issue or message can ask to be matched. The judging model depends on the
automation's provider, which the automation may inherit, so the provider in
effect can change after the automation is enabled. No run account exists before
admission.

## Decision

A provider may judge filters only after its classifier passes a release gate: a
replay of fixed GitHub and Slack fixtures, split into tuning and held-out cases,
with adversarial injection negatives and obvious positives frozen before tuning.
The gate is a fixture release gate, not a claim about accuracy on real events.
The result is recorded per provider with the prompt version and the model, so
changing either needs a new prompt version and a new gate run. The filter runs
after deterministic matching, so it can narrow a trigger's repository, label or
channel scope but never widen it.

## Consequences

- Validation and Enable check the provider resolved at that moment, and
  evaluation checks again for each event, because an inherited provider can
  change after Enable.
- Classifier calls use the default account, because no run account exists before
  admission.
