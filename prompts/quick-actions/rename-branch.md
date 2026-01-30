---
name: Rename Branch
description: Rename the branch based on conversation context
type: agent
icon: git-branch
---
Please rename the current branch to something descriptive based on our conversation so far.

Use `git branch -m <new-name>` to rename the branch. Choose a branch name that:
- Uses concrete, specific language
- Avoids abstract nouns
- Is concise (under 30 characters)
- Reflects the work being done in this workspace

Consider our conversation history and any code changes when choosing the name.
