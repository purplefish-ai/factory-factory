---
name: Fetch & Rebase
description: Fetch latest from origin and rebase onto the base branch
type: agent
icon: git-branch
---

Fetch from origin and rebase the current branch onto the PR's base branch, or
the repository's default branch if there is no PR. Preserve uncommitted work and
resolve conflicts while retaining the intent of both sides. If a conflict needs
a decision you cannot infer, report it. Summarize the result; do not push.
