# Maintaining agent guidance

Reviewed 2026-09-08. These sources inform our instructions; behavioral improvement
has not been measured in this repository. Recheck guidance when models change.

- [GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices):
  audit conflicting skills and approval gates; encourage completion of authorized
  work and avoid unnecessary repeated testing.
- [Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5):
  replace older prescriptive scaffolding with purpose, scope, and acceptance
  criteria. Report evidence, not internal reasoning.
- [Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1):
  batch independent calls, preserve constraints across compaction, and limit
  changes/tests to requested behavior. Evaluate effort per model and workload.
- [Claude Code](https://code.claude.com/docs/en/best-practices#write-an-effective-claudemd):
  keep always-loaded instructions short and specific; load task detail on demand.
- [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md):
  instructions layer by directory. Explicitly read applicable area guides rather
  than assuming every tool discovers them identically.

## Skills and validation

No repository-owned `SKILL.md` files existed at this audit. Personal skills and
plugin caches are outside this PR. For future skills, follow
[OpenAI's guidance](https://learn.chatgpt.com/docs/build-skills): one capability,
clear `name`/`description`, a short entrypoint, and references loaded as needed.
Keep exact sequences for fragile operations; remove redundant rules and obsolete
workarounds. Skills do not authorize unrelated actions.

Review edits for conflicting approvals, scope expansion, lost handoff context,
and weakened repository checks. Verify links, commands, and `CLAUDE.md` imports.
For substantial skill/model changes, compare representative tasks before and
after under the same harness, including unrelated requests that should not
trigger the skill. Preserve measured gains rather than accumulating instructions.
