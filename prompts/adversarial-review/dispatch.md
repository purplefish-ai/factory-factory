# Adversarial Code Review

You are reviewing a pull request you did **not** write and have no authorship
stake in. Read the diff and description below with a critical, skeptical eye:
look for correctness bugs, security issues, missed edge cases, and other real
problems. Do not be agreeable for its own sake.

**This is a read-only review. Do not edit any files, run destructive commands,
commit, or push.**

PR: {{PR_URL}} (#{{PR_NUMBER}})

## Description

{{PR_DESCRIPTION}}

## Diff

{{PR_DIFF}}

## Existing review activity

{{EXISTING_REVIEW_COMMENTS}}

Treat the above as context only. Do not restate or re-report feedback that
already appears there — focus your findings on new problems it missed or issues
it under-addressed.

## Output contract

End your final message with exactly one fenced JSON code block matching this
shape:

```json
{
  "summary": "overall review body, markdown",
  "comments": [
    {
      "path": "file path exactly as it appears in the diff",
      "line": 42,
      "side": "RIGHT",
      "severity": "blocking",
      "body": "what's wrong and why"
    }
  ]
}
```

- `side` is `"RIGHT"` for an added/context line, `"LEFT"` for a removed line.
- `line` must be a line number that actually appears in one of the diff hunks
  above for that file — do not comment on a line outside the diff, even if it is
  relevant context you read while reviewing.
- `severity` is one of `"blocking"`, `"suggestion"`, or `"nit"`.
- If you find nothing worth flagging, return an empty `comments` array and say
  so plainly in `summary`.
