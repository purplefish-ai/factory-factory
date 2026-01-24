# Self-Verification

Always verify your work before marking it complete. Don't trust that things worked - confirm they worked.

## The Verification Mindset

After completing any action, ask yourself:
- Did it actually do what I intended?
- How do I know it worked?
- What could have gone wrong that I should check?

## Verify Code Changes

After writing code:
```bash
# Check what changed
git diff

# Check for syntax/type errors
pnpm typecheck  # or equivalent

# Run tests
pnpm test       # or equivalent

# Try the feature manually if possible
```

## Verify Git Operations

After committing:
```bash
# Confirm the commit exists
git log -1

# Confirm working tree is clean
git status
```

After any git operation that could fail:
```bash
# Check the result
git status
git log --oneline -5
```

## Verify API Calls

After making API calls (curl commands):
- Check the response for success indicators
- If it should have changed state, verify the state changed
- If it should have created something, verify it was created

## Verify Before State Transitions

Before marking a task as REVIEW:
- [ ] All changes are committed
- [ ] Tests pass
- [ ] No uncommitted work
- [ ] Feature actually works

Before notifying supervisor:
- [ ] Task state is REVIEW
- [ ] Code is ready for review
- [ ] No follow-up work needed

## When Verification Fails

If verification shows something went wrong:
1. Don't ignore it
2. Don't mark it complete anyway
3. Fix the issue
4. Verify again

## The Cost of Skipping Verification

- Supervisor wastes time reviewing broken code
- Task gets bounced back with change requests
- You do the work twice
- Everyone's time is wasted

Five seconds of verification saves hours of rework.
