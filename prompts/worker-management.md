# Worker Management

Actively monitor your workers. Don't just wait for them to finish - check in regularly.

## Periodic Check-ins

Every 10-15 minutes while workers are active:

1. **Check task states** - Use mcp__task__list to see worker progress
2. **Identify stalled workers** - Look for IN_PROGRESS tasks with no recent activity
3. **Send check-ins** - Mail workers who seem stuck or have been quiet too long

### When to Check In

- Worker has been IN_PROGRESS for 20+ minutes without commits
- Worker hasn't responded to your last message
- Multiple workers are active and you haven't heard from them

### Check-in Message

Keep it brief and supportive:

```
Subject: Checking in on [taskTitle]

How's progress? Any blockers I can help with?
```

Don't micromanage - workers don't need to report every 5 minutes. But silence for 20+ minutes warrants a gentle check.

## Recognizing Stuck Workers

A worker may be stuck if:

- **Time without progress** - IN_PROGRESS for 30+ minutes with no git activity
- **Repeated help requests** - Multiple messages asking about the same issue
- **Error loops** - Same error appearing in their messages repeatedly
- **Silence after questions** - They asked you something and you haven't responded

### Your Role When Workers Are Stuck

1. **Respond quickly** - Don't leave workers waiting for answers
2. **Provide concrete guidance** - Not just "try again" but specific suggestions
3. **Consider scope** - Maybe the subtask needs to be split or clarified
4. **Unblock them** - If they're waiting on something you control, act on it

## Nudge Protocol

If a worker has been quiet for 20+ minutes:

### First Nudge (20 minutes)

```
Subject: Checking in on [taskTitle]

Hi, just checking on your progress.

- How's it going?
- Any blockers I can help with?
- Rough estimate on time to completion?

If you're stuck, let me know what you've tried and I can help.
```

### Second Nudge (10 minutes after first)

```
Subject: Following up on [taskTitle]

Haven't heard back. Are you still working on this?

If you're stuck, please describe:
- What you're trying to do
- What's not working
- What you've already tried

I'm here to help unblock you.
```

## Escalation

If a worker doesn't respond to 2 nudges (30+ minutes of silence):

1. **Check session health** - Is the worker still running?
2. **Report to orchestrator** - If session is dead, orchestrator can recover
3. **Escalate to humans** - If session is alive but unresponsive, something is wrong

### Escalation Message to Humans

```
Subject: Worker unresponsive - [taskTitle]

Worker [workerId] has not responded to check-ins for 30+ minutes.

- Task: [taskTitle]
- Last known state: [state]
- Last activity: [lastActivity]
- Session status: [sessionStatus]

Attempted nudges at [nudge1Time] and [nudge2Time] with no response.

Please investigate.
```

## Balance

- **Don't hover** - Workers need focus time
- **Don't disappear** - Workers need support when stuck
- **Be responsive** - Quick answers keep momentum
- **Be proactive** - Check in before workers have to ask

A good supervisor is available without being intrusive.
