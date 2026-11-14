import type { MergedPullRequest } from './pull-requests';
import { share } from './statistics';

// Pull request bodies are untrusted text: this module only splits and compares
// strings. Nothing here evaluates, renders or passes a body to a shell.

const sectionTitle = 'driven in the sandbox';

/** Merge time of #3230, which added `.github/pull_request_template.md`. */
export const templateMergedAt = '2026-11-13T22:01:22Z';

/**
 * The template's own instruction under the heading, whitespace collapsed. A
 * test fails when the template stops containing it.
 */
export const templatePlaceholder =
  'Evidence the change was driven in `pnpm dev:sandbox`: what you did and what you saw, with screenshots or output where they help. Or the reason it does not apply, for example: no user-visible behaviour changed.';

export type SandboxSectionState = 'missing' | 'empty' | 'filled';

type Heading = { level: number; title: string };

function headingOf(line: string): Heading | null {
  const match = /^ {0,3}(#{1,6})([ \t].*)?$/.exec(line);
  if (!match) {
    return null;
  }
  const title = (match[2] ?? '').trim();
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') {
    end -= 1;
  }
  // Closing hashes (`## Title ##`) only count after a space.
  const closing = end < title.length && (end === 0 || /[ \t]/.test(title[end - 1] ?? ''));
  return { level: match[1]?.length ?? 1, title: (closing ? title.slice(0, end) : title).trim() };
}

function fenceOf(line: string): { character: string; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const run = match?.[1];
  return run ? { character: run.charAt(0), length: run.length } : null;
}

type Fence = { character: string; length: number };

function closesFence(line: string, fence: Fence): boolean {
  const opening = fenceOf(line);
  return (
    opening?.character === fence.character &&
    opening.length >= fence.length &&
    line.trim().length === opening.length
  );
}

/** Each line's heading, or null for other lines and for everything inside a code fence. */
function headingsOutsideFences(lines: readonly string[]): (Heading | null)[] {
  let fence: Fence | null = null;
  return lines.map((line) => {
    if (fence !== null) {
      fence = closesFence(line, fence) ? null : fence;
      return null;
    }
    fence = fenceOf(line);
    return fence === null ? headingOf(line) : null;
  });
}

/** The lines under the first matching heading, up to the next heading of the same or a higher level. */
function sectionLines(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  const headings = headingsOutsideFences(lines);
  const start = headings.findIndex((heading) => heading?.title.toLowerCase() === sectionTitle);
  const level = headings[start]?.level;
  if (level === undefined) {
    return null;
  }
  const next = headings.findIndex(
    (heading, index) => index > start && (heading?.level ?? 7) <= level
  );
  return lines.slice(start + 1, next === -1 ? undefined : next);
}

function withoutComments(text: string): string {
  let result = '';
  let position = 0;
  for (;;) {
    const start = text.indexOf('<!--', position);
    if (start === -1) {
      return result + text.slice(position);
    }
    result += text.slice(position, start);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) {
      // An unclosed comment runs to the end, as in HTML.
      return result;
    }
    position = end + 3;
  }
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Whether the body has a "Driven in the sandbox" section and whether it holds
 * text other than whitespace, HTML comments and the template's placeholder.
 */
export function sandboxSectionState(body: string): SandboxSectionState {
  const lines = sectionLines(body);
  if (lines === null) {
    return 'missing';
  }
  const text = collapseWhitespace(withoutComments(lines.join('\n')));
  return text.replaceAll(templatePlaceholder, '').trim().length > 0 ? 'filled' : 'empty';
}

export type SandboxSectionMetrics = {
  /** Pull requests opened before this instant could not use the template. */
  templateMergedAt: string;
  /** Pull requests in the window opened before the template; not judged. */
  beforeTemplate: number;
  /** Pull requests in the window opened at or after the template merged. */
  sinceTemplate: number;
  filled: number;
  empty: number;
  missing: number;
  shareFilled: number | null;
  unfilledNumbers: number[];
};

/**
 * The share of pull requests, opened since the template merged, whose body has
 * a non-empty "Driven in the sandbox" section. A pull request that merged after
 * the template but was opened before it is not judged: its author never saw it.
 */
export function sandboxSectionMetrics(
  pullRequests: readonly MergedPullRequest[]
): SandboxSectionMetrics {
  const cutoff = Date.parse(templateMergedAt);
  const since = pullRequests.filter((pullRequest) => Date.parse(pullRequest.createdAt) >= cutoff);
  const states = since.map((pullRequest) => ({
    number: pullRequest.number,
    state: sandboxSectionState(pullRequest.body),
  }));
  const count = (wanted: SandboxSectionState) =>
    states.filter(({ state }) => state === wanted).length;
  return {
    templateMergedAt,
    beforeTemplate: pullRequests.length - since.length,
    sinceTemplate: since.length,
    filled: count('filled'),
    empty: count('empty'),
    missing: count('missing'),
    shareFilled: share(count('filled'), since.length),
    unfilledNumbers: states
      .filter(({ state }) => state !== 'filled')
      .map(({ number }) => number)
      .toSorted((left, right) => left - right),
  };
}
