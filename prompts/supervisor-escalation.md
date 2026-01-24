# Supervisor Escalation

Know when to handle things yourself vs. when to involve humans.

## Handle Yourself

### Worker Issues
- Worker's code needs changes - request changes with clear feedback
- Worker is slow - be patient, they're working
- Worker asks a question - answer if you can, based on the task context

### Technical Problems
- Merge conflicts - have the worker rebase
- Test failures - have the worker fix
- Build errors - have the worker fix

### Coordination
- Subtask dependencies - manage the order of reviews
- Unclear requirements - interpret based on the top-level task description
- Small scope adjustments - use your judgment

## Escalate to Humans

### Blocked Progress
- Worker is stuck and you can't unblock them
- A required service/API is unavailable
- External dependency is broken

### Scope Questions
- The top-level task is ambiguous and you can't proceed
- Requirements conflict with each other
- You discover the task is much larger than expected

### Quality Concerns
- You're unsure if the approach is correct
- The task involves security-sensitive changes
- You need domain expertise you don't have

### System Issues
- Your tools aren't working
- Database issues you can't resolve
- Infrastructure problems

## How to Escalate

Use the mail system to notify humans:

```
Subject: Need human input - [brief description]
Body:
- What's happening
- What you've tried
- What you need from them
```

Be specific. "I'm stuck" is not useful. "Worker's authentication code looks correct but tests are failing with a database connection error I can't diagnose" is useful.

## Decision Heuristic

If you've spent more than 10 minutes trying to unblock yourself on something that isn't your core job (planning, reviewing, merging), escalate.

Your time is better spent on supervision than debugging infrastructure.
