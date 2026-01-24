# Supervisor Task Planning

Breaking down tasks well is the most important thing you do. Good subtasks lead to smooth execution. Bad subtasks lead to blocked workers and rework.

## Subtask Principles

### Atomic
Each subtask should be independently implementable and testable. A worker should be able to complete it without waiting on other workers.

**Good**: "Add login endpoint that validates credentials and returns JWT"
**Bad**: "Build the authentication system"

### Clear
The description should contain everything a worker needs to understand what to build. Include context, requirements, and acceptance criteria.

**Good**: "Add a /health endpoint to the Express server that returns {status: 'ok'}. This will be used by our load balancer for health checks."
**Bad**: "Add health endpoint"

### Focused
Each subtask should do one thing. If you're using "and" in the title, consider splitting it.

**Good**: "Add user model with email and password fields"
**Good**: "Add user registration endpoint"
**Bad**: "Add user model and registration endpoint"

## How Many Subtasks?

Aim for **2-5 subtasks** per top-level task.

- **Too few**: Subtasks are too large, workers get stuck, code reviews are overwhelming
- **Too many**: Coordination overhead exceeds implementation time, merge conflicts increase

## Handling Dependencies

Sometimes subtasks must be done in order. When this is unavoidable:

1. Note the dependency in the subtask description
2. Consider whether you can restructure to avoid it
3. Create subtasks in the order they should be done

**Example dependency note**: "This builds on the user model from subtask 1. Wait for that to be merged before starting."

## Breaking Down the Task

When you receive a top-level task:

1. **Read the full description** - Understand the goal, not just the title
2. **Identify the components** - What distinct pieces of work are needed?
3. **Check for dependencies** - Can these be done in parallel or must they be sequential?
4. **Write clear descriptions** - Each subtask should stand alone
5. **Create the subtasks** - Use the API to create each one

## Example Breakdown

**Top-level task**: "Add user authentication to the API"

**Subtasks**:
1. "Add User model with email, passwordHash, and createdAt fields. Include a migration."
2. "Add /auth/register endpoint that creates users with hashed passwords. Return 201 on success, 400 if email taken."
3. "Add /auth/login endpoint that validates credentials and returns a JWT. Return 401 for invalid credentials."
4. "Add authentication middleware that validates JWTs and attaches user to request. Protect /api routes."
