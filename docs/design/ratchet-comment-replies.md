# Design: Always Reply to Reviewer Comments in Ratchet Mode

## Problem

It must be easy for users to tell whether a PR is ready to merge. The primary way to achieve this on a GitHub PR is to make it easy to see at a glance whether all review comments have been addressed. To enable that, the ratchet agent must respond to every review comment — whether from a human or an AI reviewer.

---

## The Relevant Prompt

**`prompts/ratchet/dispatch.md`** is the only prompt that matters here. It is loaded by `src/backend/prompts/ratchet-dispatch.ts` and injected as the initial message each time the ratchet fixer fires automatically. The `{{PR_NUMBER}}`, `{{PR_URL}}`, and `{{REVIEW_COMMENTS}}` placeholders are filled in at runtime from live PR data.

---

## Current Step Sequence in `dispatch.md`

| # | Step | Posts to GitHub? |
|---|------|-----------------|
| 1 | Merge base branch + resolve conflicts | No |
| 2 | Fix CI failures | No |
| 3 | Address unaddressed review comments | No |
| 4 | Run build/lint/test | No |
| 5 | Push (only if actionable changes made) | Yes — git push |
| 6 | Comment on addressed comments + resolve threads | Yes — per-thread replies |
| 7 | Request re-review via `gh pr edit --add-reviewer` | Yes — reviewer assignment |
| 8 | Post top-level PR comment tagging all reviewers | Yes — top-level comment |

**Step 6 already exists** and already posts per-thread replies. Its current scope is narrow: it only replies to comments that were acted on. Comments the agent judged non-actionable receive no reply at all — and neither do comments from AI reviewers.

---

## Design Options

### Option A — Modify step 6 (recommended)

Extend step 6's scope to cover all review comments (human and AI), not just acted-on ones.

Current wording:
> Comment briefly on addressed review comments and resolve them. IMPORTANT: When responding to a comment, explicitly @ mention the person who made the comment (e.g., "@username - fixed as suggested").

Proposed wording:
> Reply to **every** review comment — from humans and AI reviewers alike — and resolve addressed threads. For each comment you acted on, explain what you changed and where (file + line). For each comment you did not act on, explain why (e.g. "intentional design", "out of scope for this PR", "this is informational — no change needed"). Always @ mention the commenter.

**Pros:**
- Step 6 is already the post-push GitHub communication step — widening its scope is the natural fit.
- No renumbering. Steps 7 and 8 stay where they are.
- The agent does one sweep of all comments in one pass rather than two separate steps.
- Keeps all per-thread reply logic in one place, reducing the chance of duplication or skipping.

**Cons:**
- Step 6 becomes a few lines longer. Not a meaningful issue for LLM instruction-following.

---

### Option B — Add a new step between 5 and 6

Insert a dedicated step: "Reply to all non-actionable comments." Step 6 retains its current scope (acted-on comments only). The new step handles everything else.

**Pros:**
- Explicit, numbered, hard to skip.
- Visually distinguishes "acknowledgment replies" from "resolution replies."

**Cons:**
- Creates two adjacent steps that both post per-thread GitHub comments. The agent may execute one and treat it as sufficient, or produce duplicate replies to comments that straddle both categories.
- Steps 7 and 8 are also GitHub-comment steps. Three consecutive GitHub-comment steps increases the chance the agent collapses them or skips one.
- Renumbers steps 6–8, complicating future diffs.
- The distinction between "acted on" and "not acted on" is not always sharp mid-session; splitting the reply logic across two steps invites inconsistency.

---

### Option C — Split by timing: reply to non-actionable in step 3, actionable in step 6

Reply to comments the agent decides not to act on immediately during step 3 (while processing comments), then reply to acted-on comments after the push in step 6.

**Pros:**
- Non-actionable replies go out fast, before any code work.

**Cons:**
- The agent's judgment about whether a comment is actionable can change as it implements fixes. Replies posted in step 3 may become incorrect.
- Reviewers see partial comment activity mid-session, which is confusing.
- Significantly more complex prompt structure.

---

## Recommendation

**Option A — modify step 6.** Step 6 already owns per-thread replies; extending its scope to all review comments is a minimal, coherent change. It avoids the fragmentation and duplication risks of Option B and the timing problems of Option C.

---

## Proposed Step 6 Wording

```
6. Reply to every review comment (human or AI) and resolve addressed threads.
   - For each comment you acted on: explain what you changed and where (file + line), then resolve the thread.
   - For each comment you did not act on: explain why (e.g. "intentional design", "out of scope for this PR", "this is informational — no change needed").
   - Always explicitly @ mention the commenter in your reply (e.g. "@username — fixed as suggested").
   - This step is MANDATORY regardless of whether any code changes were made.
```
