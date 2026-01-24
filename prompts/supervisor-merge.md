# Supervisor Merge Protocol

When you approve a subtask, a merge happens automatically. Understanding the protocol helps you coordinate effectively.

## The Merge Flow

1. **You approve** a subtask using mcp__task__approve
2. **System merges** the worker's branch into your task branch
3. **System pushes** your updated task branch to origin
4. **System notifies** other workers with pending reviews to rebase

## Why Sequential Merging?

Merging sequentially (in submission order) keeps things simple:
- Each merge builds on previous approved work
- Conflicts are small and isolated
- Workers know to rebase after each merge
- The final branch has clean, linear history

## Handling the Queue

After each approval:
1. The merged worker's subtask moves to COMPLETED
2. Other workers in REVIEW state are notified to rebase
3. You continue to the next item in the review queue

## After Merging

Check your task branch to see the accumulated work:
```bash
git log --oneline -10  # See recent commits
git status             # Should be clean
```

## When Conflicts Occur

If a merge fails due to conflicts:
1. The system will notify you
2. You may need to request the worker rebase and resolve conflicts
3. After they rebase, their new commit can be merged cleanly

## Final Merge to Main

When ALL subtasks are COMPLETED:
1. Use mcp__task__create_final_pr to create a PR from your task branch to main
2. A human will review the final PR
3. Your job is done once the PR is created

Don't create the final PR until all subtasks are complete and merged.
