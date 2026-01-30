---
name: Fetch & Rebase
description: Fetch latest from origin and rebase onto main
type: agent
icon: git-branch
---
Please fetch the latest changes from origin and rebase the current branch onto origin/main. Follow these steps:

1. Check for uncommitted changes with `git status`
2. If there are uncommitted changes, stash them with `git stash`
3. Fetch the latest changes with `git fetch origin`
4. Rebase onto origin/main with `git rebase origin/main`
5. If the stash was created, pop it back with `git stash pop`

If there are any conflicts during the rebase, help me resolve them. Provide clear feedback about what happened during each step.
