---
name: Address PR Comments
description: Fetch review comments and address the feedback
type: agent
icon: chat-text
---

Resolve the current branch's pull requests first using the GitHub CLI (gh). If
there is no unique matching open PR, ask for an explicit PR number before
fetching feedback. Then fetch that PR's unresolved review threads and comments,
validate the feedback, address valid requested changes, and explain any feedback
you disagree with before resolving its thread.
