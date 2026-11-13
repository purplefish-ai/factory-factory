# Review requests and gh health are cached rather than read every poll

Originally decided on 2026-11-09 in #3119.

## Context

A 150-second sample of child processes on the live server showed 18
`gh api graphql` and 4 `gh auth status` spawns on top of PR monitoring. The
always-mounted sidebar badge polled review requests every 30 seconds, each poll
ran an uncached GitHub search, and because the health cache expired as often as
the poll, most polls also rechecked `gh` health.

## Decision

`GitHubCLIService.listReviewRequests` caches each search for two minutes, keyed
by lowercase repository; the global review-count search has its own entry. The
cache is stale-while-revalidate: a stale entry is returned at once while one
background search refreshes it, and a failed refresh keeps the stale entry. The
client polls on the same two-minute cadence. Refresh and Retry on the Reviews
page force a new health check and search.

The `gh` health check keeps a healthy result for five minutes and an unhealthy
one for 30 seconds, so `gh auth login` is noticed quickly. A `gh` command that
fails for missing authentication or a missing binary discards a healthy result
and the cached review requests, which may belong to the previous account.

## Consequences

- Every window shares one search per repository per interval.
- A review requested on GitHub can take up to about four minutes to appear
  without pressing Refresh. Submitting a review drops the cache, including
  searches already running.
