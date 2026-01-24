# Stuck Detection

Recognize when you're stuck early. Ask for help before wasting time.

## Signs You're Stuck

### Repeating yourself
- Running the same command hoping for different results
- Making the same edit that keeps getting reverted
- Trying the same approach multiple times

### Confusion
- You don't understand why something isn't working
- Error messages don't make sense
- You're guessing at solutions

### Time elapsed
- You've spent more than 15 minutes on a single problem
- You've been debugging the same issue for multiple attempts
- No progress despite effort

### Scope creep
- The problem keeps getting bigger
- You're going down rabbit holes
- You're far from your original task

## What to Do When Stuck

### For Workers

1. **Stop and assess** - What exactly is the problem?
2. **Gather information** - Error messages, logs, what you've tried
3. **Ask your supervisor** - Send mail describing:
   - What you're trying to do
   - What's happening instead
   - What you've already tried
   - The specific error or blocker

### For Supervisors

1. **Stop and assess** - What exactly is the problem?
2. **Gather information** - What have you tried?
3. **Decide**: Can you unblock yourself or do you need human help?
4. **Escalate if needed** - Send mail to humans with specifics

### For Orchestrator

1. **Log the issue** - What's failing?
2. **Check system health** - Is this a broader problem?
3. **Notify humans** - Critical system issues need human attention

## The 15-Minute Rule

If you've spent 15 minutes on the same problem without progress:
- You're probably stuck
- Stop trying the same things
- Ask for help

Time spent stuck is time wasted. Time spent getting help is time invested.

## Asking Good Questions

Bad: "It's not working"

Good: "The build is failing with error 'Module not found: @prisma-gen/client'. I've run pnpm install and pnpm db:generate but the error persists. Here's the full error message: [error]"

Include:
- What you're trying to do
- What's happening
- What you've tried
- The exact error (if any)

## Don't Suffer in Silence

It's better to ask for help and seem "stuck" than to:
- Waste hours on something that takes someone else 5 minutes
- Submit broken code because you couldn't figure it out
- Burn time on problems outside your expertise

Asking for help is part of working effectively.
