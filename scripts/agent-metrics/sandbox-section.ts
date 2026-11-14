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

type Fence = { character: string; length: number };

function fenceOf(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const run = match?.[1];
  return run ? { character: run.charAt(0), length: run.length } : null;
}

function closesFence(line: string, fence: Fence): boolean {
  const opening = fenceOf(line);
  return (
    opening?.character === fence.character &&
    opening.length >= fence.length &&
    line.trim().length === opening.length
  );
}

/** `line` without its HTML comments, and whether a comment is still open at its end. */
function stripComments(line: string, startsInComment: boolean): { text: string; open: boolean } {
  let text = '';
  let position = 0;
  let open = startsInComment;
  for (;;) {
    if (open) {
      const end = line.indexOf('-->', position);
      if (end === -1) {
        // An unclosed comment runs on, as in HTML.
        return { text, open };
      }
      position = end + 3;
      open = false;
    } else {
      const start = line.indexOf('<!--', position);
      if (start === -1) {
        return { text: text + line.slice(position), open };
      }
      text += line.slice(position, start);
      position = start + 4;
      open = true;
    }
  }
}

type ScannedLine = {
  heading: Heading | null;
  text: string;
  /** The line begins inside a comment, so the line break before it was part of the comment. */
  continuesComment: boolean;
};

/**
 * Each line's visible text (without comments outside code fences) and its
 * heading. A line inside a code fence or a comment is never a heading.
 */
function scanLines(lines: readonly string[]): ScannedLine[] {
  let fence: Fence | null = null;
  let inComment = false;
  return lines.map((line) => {
    if (fence !== null) {
      fence = closesFence(line, fence) ? null : fence;
      return { heading: null, text: line, continuesComment: false };
    }
    const continuesComment = inComment;
    const { text, open } = stripComments(line, inComment);
    // A fence opener's info string is not markup, so a `<!--` there opens no comment.
    fence = continuesComment ? null : fenceOf(line);
    inComment = fence === null ? open : false;
    const heading = continuesComment || fence !== null ? null : headingOf(text);
    return { heading, text, continuesComment };
  });
}

/** The text under the first matching heading, up to the next heading of the same or a higher level. */
function sectionText(body: string): string | null {
  const scanned = scanLines(body.split(/\r\n|\r|\n/));
  const start = scanned.findIndex(({ heading }) => heading?.title.toLowerCase() === sectionTitle);
  const level = scanned[start]?.heading?.level;
  if (level === undefined) {
    return null;
  }
  const next = scanned.findIndex(
    ({ heading }, index) => index > start && heading !== null && heading.level <= level
  );
  return scanned
    .slice(start + 1, next === -1 ? undefined : next)
    .map(({ text, continuesComment }) => (continuesComment ? text : `\n${text}`))
    .join('');
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Whether the body has a "Driven in the sandbox" section and whether it holds
 * text other than whitespace, HTML comments and the template's placeholder.
 */
export function sandboxSectionState(body: string): SandboxSectionState {
  const text = sectionText(body);
  if (text === null) {
    return 'missing';
  }
  return collapseWhitespace(text).replaceAll(templatePlaceholder, '').trim().length > 0
    ? 'filled'
    : 'empty';
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
