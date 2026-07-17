# Plan Tool Result Text Design

## Problem

Completed Codex plan items can contain only metadata, such as `type`, `id`, and `status`. The agent-activity plan renderer currently passes the entire item to the permissive shared plan-text extractor. Its fallback selects the longest string, so an item ID can be displayed as plan text.

## Scope

Keep the shared plan extractor and backend plan-approval flow unchanged. Restrict only agent-activity plan tool-result rendering so a typed plan envelope is specialized when it contains nonblank text under an explicit `plan`, `markdown`, `text`, or `content` field. Otherwise, return `null` and let the generic tool-result renderer display the raw result.

## Design

After locating a `type: "plan"` payload, inspect only the four plan-bearing fields. Validation follows those fields through arrays and nested plan-bearing or typed text/markdown objects, preserving the existing `plan.content[]` format without allowing unrelated metadata such as `id` or `status` to qualify. Once content is validated, the existing shared extractor performs the final normalization.

Alternatives rejected:

- Changing the shared extractor would alter ExitPlanMode and permission consumers outside this bug.
- Requiring a top-level string would reject the already-supported nested `plan.content[]` payload.
- Checking only field presence would allow blank or metadata-only nested fields to fall through to an ID.

## Tests

Add focused parser regressions for metadata-only payloads, blank explicit text, and nested metadata beneath a plan field. Preserve the existing positive coverage for direct text, fenced JSON, and nested structured content. Focused tests must fail before the production change and pass afterward; the repository typecheck, formatter/checks, full tests, and build must pass before completion.

## UI Verification

This changes which existing renderer branch is selected and adds no visual layout or styling. Automated parser/renderer coverage is the deterministic verification; no new screenshot fixture is required.
