import type { MergedPullRequest } from './pull-requests';
import { share } from './statistics';

// Pull request bodies are untrusted text: this module only splits and compares
// strings. Nothing here evaluates, renders or passes a body to a shell.

const sectionTitle = 'driven in the sandbox';

/** Merge time of #3230, which added `.github/pull_request_template.md`. */
export const templateMergedAt = '2026-11-13T22:01:22Z';

export const templatePath = '.github/pull_request_template.md';

/**
 * A keyword the template's instruction contains and no earlier version of the
 * template did. The commit that first added it to the template is when authors
 * began to see the keyword instruction; a test fails when the template stops
 * containing it. It is also the keyword the parser reads, so changing it
 * changes what the metric measures, not only when it starts.
 */
export const keywordInstructionMarker = 'Does not apply:';

const drivenKeyword = 'driven:';
const notApplicableKeyword = keywordInstructionMarker.toLowerCase();

/**
 * The template's own instruction under the heading, whitespace collapsed. A
 * test fails when the template stops containing it.
 */
export const templatePlaceholder =
  'Begin with "Driven:" and what you did and saw in `pnpm dev:sandbox`, with screenshots or output where they help. Or begin with "Does not apply:" and the reason, for example: no user-visible behaviour changed.';

/**
 * The instruction before the keywords, which pull requests opened from the
 * first template may still carry.
 */
const firstTemplatePlaceholder =
  'Evidence the change was driven in `pnpm dev:sandbox`: what you did and what you saw, with screenshots or output where they help. Or the reason it does not apply, for example: no user-visible behaviour changed.';

const placeholders = [templatePlaceholder, firstTemplatePlaceholder];

/** What the automated reviewer appends to a body, from its opening comment to its closing one. */
const reviewerBlockStart = '<!-- This is an auto-generated description by cubic';
const reviewerBlockEnd = '<!-- End of auto-generated description by cubic. -->';

const attributionPrefix = '🤖 Generated with';

/** Judged by the text of the section alone: whether it holds anything. */
export type SandboxSectionState = 'missing' | 'empty' | 'filled';

/** Judged by the keyword the section begins with. */
export type SandboxSectionLabel = 'missing' | 'empty' | 'driven' | 'not-applicable' | 'unlabelled';

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

/** `body` without the blocks the automated reviewer appends; an unclosed one runs to the end. */
function withoutReviewerBlocks(body: string): string {
  let kept = '';
  let position = 0;
  for (;;) {
    const start = body.indexOf(reviewerBlockStart, position);
    if (start === -1) {
      return kept + body.slice(position);
    }
    kept += body.slice(position, start);
    const end = body.indexOf(reviewerBlockEnd, start);
    if (end === -1) {
      return kept;
    }
    position = end + reviewerBlockEnd.length;
  }
}

function isHorizontalRule(line: string): boolean {
  const marks = line.replaceAll(/[ \t]/g, '');
  const first = marks.charAt(0);
  return marks.length >= 3 && '-*_'.includes(first) && [...marks].every((mark) => mark === first);
}

/**
 * The lines that can carry meaning: not horizontal rules, not the attribution
 * line, not a code fence with nothing inside. Each line is read once.
 */
function meaningfulLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = fenceOf(line);
    if (fence === null) {
      if (!(isHorizontalRule(line) || line.trim().startsWith(attributionPrefix))) {
        kept.push(line);
      }
      index += 1;
    } else {
      const { end, blank } = fenceExtent(lines, index, fence);
      if (!blank) {
        appendRange(kept, lines, index, end + 1);
      }
      index = end + 1;
    }
  }
  return kept;
}

/** Spreading a range of 100,000 lines into `push` would overflow the stack. */
function appendRange(target: string[], lines: readonly string[], from: number, to: number): void {
  for (let index = from; index < Math.min(to, lines.length); index += 1) {
    target.push(lines[index] ?? '');
  }
}

/** The last line of the code fence opened at `start` (the last line of all if it is not closed), and whether it holds only blank lines. */
function fenceExtent(
  lines: readonly string[],
  start: number,
  fence: Fence
): { end: number; blank: boolean } {
  let end = start + 1;
  let blank = true;
  while (end < lines.length && !closesFence(lines[end] ?? '', fence)) {
    blank = blank && (lines[end] ?? '').trim() === '';
    end += 1;
  }
  return { end, blank };
}

// Zero width space, non-joiner, joiner, word joiner and byte order mark. Written
// as code points: a source file should not carry invisible characters.
const zeroWidthCharacters = [0x20_0b, 0x20_0c, 0x20_0d, 0x20_60, 0xfe_ff].map((codePoint) =>
  String.fromCodePoint(codePoint)
);

function withoutZeroWidthCharacters(text: string): string {
  return zeroWidthCharacters.reduce((kept, character) => kept.replaceAll(character, ''), text);
}

/**
 * The section's text, whitespace collapsed, without what is not the author's:
 * comments, zero-width characters (also in the heading), the template's
 * placeholder, rules, empty code fences, the attribution line and the
 * reviewer's block. `null` when the body has no such section.
 */
function sectionContent(body: string): string | null {
  const text = sectionText(withoutZeroWidthCharacters(withoutReviewerBlocks(body)));
  if (text === null) {
    return null;
  }
  const lines = meaningfulLines(text.split('\n'));
  return placeholders.reduce(
    (content, placeholder) => content.replaceAll(placeholder, ''),
    collapseWhitespace(lines.join('\n'))
  );
}

/**
 * Whether the body has a "Driven in the sandbox" section and whether it holds
 * text other than whitespace, HTML comments, the template's placeholder and
 * what an automated step appends.
 */
export function sandboxSectionState(body: string): SandboxSectionState {
  const content = sectionContent(body);
  if (content === null) {
    return 'missing';
  }
  return content.trim().length > 0 ? 'filled' : 'empty';
}

const emphasisCharacters = '*_`';

/** The first position at or after `from` whose character is not one of `skipped`. */
function skipCharacters(text: string, from: number, skipped: string): number {
  let position = from;
  while (position < text.length && skipped.includes(text.charAt(position))) {
    position += 1;
  }
  return position;
}

/**
 * The text after `keyword` (a word and its colon) when `content` begins with
 * it, in any case. One list marker (`- ` or `* `) and emphasis characters
 * (`*`, `_`, backtick) before the word, between it and its colon and after the
 * colon are skipped, so `**Driven:** x` and `- Driven: x` read by their keyword.
 * One scan from the start: the cost does not depend on what follows.
 */
function afterKeyword(content: string, keyword: string): string | null {
  const word = keyword.slice(0, -1);
  const marker = content.startsWith('- ') || content.startsWith('* ') ? 2 : 0;
  const start = skipCharacters(content, marker, emphasisCharacters);
  if (content.slice(start, start + word.length).toLowerCase() !== word) {
    return null;
  }
  const colon = skipCharacters(content, start + word.length, emphasisCharacters);
  if (content.charAt(colon) !== ':') {
    return null;
  }
  return content.slice(skipCharacters(content, colon + 1, `${emphasisCharacters} `)).trim();
}

/**
 * The section by the keyword it begins with: `Driven:` or `Does not apply:`
 * (also as a list item or in bold, italics or code), followed by text. A
 * keyword with nothing after it is `empty`, since it
 * records neither what was done nor why not.
 */
export function sandboxSectionLabel(body: string): SandboxSectionLabel {
  const content = sectionContent(body)?.trim();
  if (content === undefined) {
    return 'missing';
  }
  if (content === '') {
    return 'empty';
  }
  const driven = afterKeyword(content, drivenKeyword);
  const notApplicable = afterKeyword(content, notApplicableKeyword);
  const reason = driven ?? notApplicable;
  if (reason === null) {
    return 'unlabelled';
  }
  if (reason === '') {
    return 'empty';
  }
  return driven === null ? 'not-applicable' : 'driven';
}

export type SandboxSectionMetrics = {
  /** Pull requests opened before this instant could not use the template. */
  templateMergedAt: string;
  /** Pull requests opened before this instant were not asked for the keyword. */
  keywordInstructionAt: string;
  /** Pull requests in the window opened before the template; not judged. */
  beforeTemplate: number;
  /** Opened from the template until the keyword instruction: filled or empty only. */
  byContent: {
    opened: number;
    filled: number;
    empty: number;
    missing: number;
    shareFilled: number | null;
  };
  /** Opened since the keyword instruction: judged by the keyword the section begins with. */
  byKeyword: {
    judged: number;
    driven: number;
    notApplicable: number;
    unlabelled: number;
    empty: number;
    missing: number;
    /** `driven` over `judged` less `notApplicable`. */
    shareDriven: number | null;
    /** Neither driven nor not applicable: unlabelled, empty or missing. */
    unclassifiedNumbers: number[];
  };
};

/**
 * How the pull requests in the window answered "Driven in the sandbox". One
 * opened before the template merged is not judged: its author never saw it.
 * One opened from then until `keywordInstructionAt` (when the template began to
 * ask for a keyword) is judged only by whether the section holds text. One
 * opened since is judged by its keyword.
 */
export function sandboxSectionMetrics(
  pullRequests: readonly MergedPullRequest[],
  keywordInstructionAt: string
): SandboxSectionMetrics {
  const templateCutoff = Date.parse(templateMergedAt);
  const keywordCutoff = Date.parse(keywordInstructionAt);
  const openedAt = (pullRequest: MergedPullRequest) => Date.parse(pullRequest.createdAt);
  const since = pullRequests.filter((pullRequest) => openedAt(pullRequest) >= templateCutoff);
  const states = since
    .filter((pullRequest) => openedAt(pullRequest) < keywordCutoff)
    .map((pullRequest) => sandboxSectionState(pullRequest.body));
  const labelled = since
    .filter((pullRequest) => openedAt(pullRequest) >= keywordCutoff)
    .map((pullRequest) => ({
      number: pullRequest.number,
      label: sandboxSectionLabel(pullRequest.body),
    }));
  const countStates = (wanted: SandboxSectionState) =>
    states.filter((state) => state === wanted).length;
  const countLabels = (wanted: SandboxSectionLabel) =>
    labelled.filter(({ label }) => label === wanted).length;
  return {
    templateMergedAt,
    keywordInstructionAt,
    beforeTemplate: pullRequests.length - since.length,
    byContent: {
      opened: states.length,
      filled: countStates('filled'),
      empty: countStates('empty'),
      missing: countStates('missing'),
      shareFilled: share(countStates('filled'), states.length),
    },
    byKeyword: {
      judged: labelled.length,
      driven: countLabels('driven'),
      notApplicable: countLabels('not-applicable'),
      unlabelled: countLabels('unlabelled'),
      empty: countLabels('empty'),
      missing: countLabels('missing'),
      shareDriven: share(countLabels('driven'), labelled.length - countLabels('not-applicable')),
      unclassifiedNumbers: labelled
        .filter(({ label }) => label !== 'driven' && label !== 'not-applicable')
        .map(({ number }) => number)
        .toSorted((left, right) => left - right),
    },
  };
}
