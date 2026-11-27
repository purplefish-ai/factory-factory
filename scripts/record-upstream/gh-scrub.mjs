// Allowlist scrubber for `gh` recordings (see ./gh.mjs and ./gh-policies.mjs).
//
// A recording is published in a public repository. Pull requests and issues
// carry other people's text and accounts, so nothing survives because it
// "looks safe": each call shape names the key paths it keeps and how, and
// every other key is dropped. Treatments:
//
// - `keep`: enums, check and label names, booleans and numbers. A string
//   survives only when it is short, single-line and carries nothing that
//   looks private, no login seen anywhere in the recording and no term from
//   the leak test's forbidden list; otherwise it becomes "<string>". The
//   pattern still admits free text ("Deploy by Jane Doe"), which is acceptable
//   only because these names come from a public repository, where anyone can
//   read them; the recorder refuses a repository that is not public.
// - `number`: a number a parser reads (object numbers, line counts).
// - `id`: a fixed fake. Numeric ids (also numeric strings) become 1000001,
//   1000002, … and node ids `fake-node-N`; the same id always gets the same
//   fake, across files, so joins between REST and GraphQL ids still line up.
// - `login`: `user-N`, `bot-N[bot]` or `app/bot-N`, the same per account.
// - `text`: free text (titles, bodies, comments, file paths) becomes
//   "<text>"; an empty string stays empty.
// - `url`: github.com and api.github.com keep their path words; the
//   repository becomes the fake one, a pull request or issue number stays,
//   any other number becomes a fake id, the query keeps only `page` and
//   `per_page`, and a comment anchor keeps its kind. Any other host becomes
//   example.invalid.
// - `time`: fake timestamps from 2026-01-01 that keep the real order and the
//   original's shape: the same number of fraction digits, and `Z` or an offset
//   (always `+00:00`, so no time zone is kept).
// - `sha`, `branch`, `cursor`: fixed fakes (`main` stays `main`).
// - `repo`, `repo-name`: the fake repository; any other one `other-owner/repo-N`.
// - `present`: an object becomes `{}`; only its presence is kept.
//
// Text output (`--version`, `auth status`, `--jq` reads) passes line
// templates; a line that matches none becomes "<line>".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksPrivate } from './scrub.mjs';

export const PLACEHOLDER = '<string>';
export const TEXT = '<text>';
export const LINE = '<line>';
const ZERO_TIME = '0001-01-01T00:00:00Z';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const FAKE_EPOCH = Date.parse('2026-01-01T00:00:00Z');
const KEEPABLE = /^[\p{L}\p{N} _.,:;()/'&+#@·|[\]-]{0,120}$/u;
const URL_WORDS = new Set([
  'actions',
  'check-runs',
  'checks',
  'comments',
  'commit',
  'commits',
  'events',
  'files',
  'issues',
  'job',
  'jobs',
  'labels',
  'pull',
  'pulls',
  'repos',
  'repositories',
  'reviews',
  'runs',
]);
const OBJECT_NUMBER_AFTER = new Set(['pull', 'pulls', 'issues']);
const ANCHOR = /^(issuecomment-|pullrequestreview-|discussion_r)(\d+)$/;

const forbiddenTerms = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'src',
      'backend',
      'testing',
      'upstream-recordings-forbidden.json'
    ),
    'utf8'
  )
).terms.map((term) => term.toLowerCase());

/**
 * Per-recording state. `repository` is the real `owner/name`, `fake` its
 * replacement. `logins` and `times` come from `collectScrubFacts`, so a
 * kept string can be checked against every login and timestamps keep their
 * order.
 *
 * @param {{ repository: string, fake: { owner: string, name: string }, logins?: string[], times?: string[] }} options
 */
export function createGhScrubContext({ repository, fake, logins = [], times = [] }) {
  const [owner, name] = repository.split('/');
  const sortedTimes = [...new Set(times)].filter((time) => time !== ZERO_TIME).sort(compareTimes);
  return {
    owner,
    name,
    fake,
    knownLogins: [...new Set(logins)].map((login) => login.toLowerCase()),
    timeIndex: new Map(sortedTimes.map((time, index) => [time, index])),
    fakes: new Map(),
    counters: new Map(),
    droppedKeys: 0,
  };
}

function compareTimes(a, b) {
  return Date.parse(a) - Date.parse(b) || a.localeCompare(b);
}

function nextFake(context, kind, original, make) {
  const key = `${kind}\u0000${original}`;
  let fake = context.fakes.get(key);
  if (fake === undefined) {
    const n = (context.counters.get(kind) ?? 0) + 1;
    context.counters.set(kind, n);
    fake = make(n);
    context.fakes.set(key, fake);
  }
  return fake;
}

const fakeNumber = (context, value) =>
  nextFake(context, 'number', String(value), (n) => 1_000_000 + n);

export function fakeLogin(context, login) {
  if (login.endsWith('[bot]')) {
    return nextFake(context, 'login', login, (n) => `bot-${n}[bot]`);
  }
  if (login.startsWith('app/')) {
    return nextFake(context, 'login', login, (n) => `app/bot-${n}`);
  }
  return nextFake(context, 'login', login, (n) => `user-${n}`);
}

function fakeTime(context, value) {
  if (value === ZERO_TIME) {
    return value;
  }
  const index = context.timeIndex.get(value);
  if (index === undefined) {
    return PLACEHOLDER;
  }
  const [, fraction = '', zone = 'Z'] = ISO_TIME.exec(value) ?? [];
  const seconds = new Date(FAKE_EPOCH + index * 60_000).toISOString().slice(0, 19);
  return `${seconds}${fraction.replace(/\d/g, '0')}${zone === 'Z' ? 'Z' : '+00:00'}`;
}

function replaceRepository(value, context) {
  return value
    .split(`${context.owner}/${context.name}`)
    .join(`${context.fake.owner}/${context.fake.name}`);
}

/** True when a kept string still names something it must not. */
function unsafeToKeep(value, context) {
  const lower = value.toLowerCase();
  return (
    !KEEPABLE.test(value) ||
    looksPrivate(value) ||
    forbiddenTerms.some((term) => lower.includes(term)) ||
    context.knownLogins.some((login) => namesLogin(lower, login))
  );
}

/**
 * True when `lower` contains `login`: anywhere for a login of three or more
 * characters, and as a whole word for a shorter one, which would otherwise
 * match inside ordinary words.
 */
function namesLogin(lower, login) {
  if (login.length >= 3) {
    return lower.includes(login);
  }
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`).test(lower);
}

function keepString(value, context) {
  const replaced = replaceRepository(value, context);
  return unsafeToKeep(replaced, context) ? PLACEHOLDER : replaced;
}

function fakePathSegments(segments, context) {
  const result = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment.toLowerCase() === context.owner.toLowerCase() &&
      segments[index + 1]?.toLowerCase() === context.name.toLowerCase()
    ) {
      result.push(context.fake.owner, context.fake.name);
      index += 1;
    } else if (URL_WORDS.has(segment)) {
      result.push(segment);
    } else if (/^\d+$/.test(segment)) {
      result.push(
        OBJECT_NUMBER_AFTER.has(segments[index - 1] ?? '') && segment.length <= 7
          ? segment
          : String(fakeNumber(context, segment))
      );
    } else {
      result.push('x');
    }
  }
  return result;
}

export function fakeUrl(value, context) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return PLACEHOLDER;
  }
  if (!(url.protocol === 'https:' && ['github.com', 'api.github.com'].includes(url.hostname))) {
    return 'https://example.invalid/';
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const path = fakePathSegments(segments, context).join('/');
  const query = [...url.searchParams]
    .filter(([key, item]) => (key === 'page' || key === 'per_page') && /^\d{1,4}$/.test(item))
    .map(([key, item]) => `${key}=${item}`)
    .join('&');
  const anchor = ANCHOR.exec(url.hash.slice(1));
  const hash = anchor ? `#${anchor[1]}${fakeNumber(context, anchor[2])}` : '';
  return `https://${url.hostname}/${path}${query ? `?${query}` : ''}${hash}`;
}

function treatString(treatment, value, context) {
  switch (treatment) {
    case 'keep':
      return keepString(value, context);
    case 'id':
      return /^\d+$/.test(value)
        ? String(fakeNumber(context, value))
        : nextFake(context, 'node', value, (n) => `fake-node-${n}`);
    case 'login':
      return fakeLogin(context, value);
    case 'text':
      return value === '' ? '' : TEXT;
    case 'url':
      return fakeUrl(value, context);
    case 'time':
      return ISO_TIME.test(value) ? fakeTime(context, value) : PLACEHOLDER;
    case 'sha':
      return nextFake(context, 'sha', value, (n) => `fake-sha-${n}`);
    case 'branch':
      return value === 'main' ? value : nextFake(context, 'branch', value, (n) => `branch-${n}`);
    case 'cursor':
      return nextFake(context, 'cursor', value, (n) => `fake-cursor-${n}`);
    case 'repo':
      return value.toLowerCase() === `${context.owner}/${context.name}`.toLowerCase()
        ? `${context.fake.owner}/${context.fake.name}`
        : nextFake(context, 'repo', value, (n) => `other-owner/repo-${n}`);
    case 'repo-name':
      return value.toLowerCase() === context.name.toLowerCase()
        ? context.fake.name
        : nextFake(context, 'repo-name', value, (n) => `repo-${n}`);
    default:
      return PLACEHOLDER;
  }
}

/** One value at a listed path. */
export function treatValue(treatment, value, context) {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => treatValue(treatment, item, context));
  }
  if (treatment === 'present') {
    return typeof value === 'object' ? {} : PLACEHOLDER;
  }
  if (typeof value === 'object') {
    return PLACEHOLDER;
  }
  if (typeof value === 'boolean') {
    return treatment === 'keep' ? value : false;
  }
  if (typeof value === 'number') {
    if (treatment === 'id') {
      return fakeNumber(context, value);
    }
    return treatment === 'keep' || treatment === 'number' ? value : 0;
  }
  if (typeof value === 'string') {
    return treatString(treatment, value, context);
  }
  return PLACEHOLDER;
}

function compileFields(fields) {
  const treatments = new Map(Object.entries(fields));
  const parents = new Set();
  for (const path of treatments.keys()) {
    const parts = path.split('.');
    for (let length = 1; length < parts.length; length += 1) {
      parents.add(parts.slice(0, length).join('.'));
    }
  }
  return { treatments, parents };
}

function walk(value, compiled, context, path) {
  if (path !== '' && compiled.treatments.has(path)) {
    return treatValue(compiled.treatments.get(path), value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, compiled, context, path));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (compiled.treatments.has(childPath) || compiled.parents.has(childPath)) {
        result[key] = walk(child, compiled, context, childPath);
      } else {
        context.droppedKeys += 1;
      }
    }
    return result;
  }
  // A scalar where an object was expected keeps nothing but its type.
  return typeof value === 'string' ? PLACEHOLDER : typeof value === 'number' ? 0 : value;
}

/** Keeps only the listed key paths of `json`, each scrubbed by its treatment. */
export function scrubJson(json, fields, context) {
  return walk(json, compileFields(fields), context, '');
}

function itemsAt(json, path) {
  if (!path) {
    return json;
  }
  return path
    .split('.')
    .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), json);
}

/**
 * Trims the list at `trim.path` (the top level by default; each page of a
 * `--slurp` read) to `trim.limit` items, by `trim.select` when given.
 * Returns the trimmed copy and how many items were kept of how many.
 */
export function trimOutput(json, trim) {
  if (!trim) {
    return { json, kept: null };
  }
  const copy = structuredClone(json);
  const counts = { kept: 0, of: 0 };
  const cut = (items) => {
    if (items.every(Array.isArray)) {
      return items.map(cut);
    }
    const kept = trim.select ? trim.select(items, trim.limit) : items.slice(0, trim.limit);
    counts.kept += kept.length;
    counts.of += items.length;
    return kept;
  };
  if (!trim.path) {
    return { json: Array.isArray(copy) ? cut(copy) : copy, kept: counts };
  }
  const parts = trim.path.split('.');
  const parent = itemsAt(copy, parts.slice(0, -1).join('.'));
  const key = parts.at(-1);
  if (parent && Array.isArray(parent[key])) {
    parent[key] = cut(parent[key]);
  }
  return { json: copy, kept: counts };
}

/** Walks `json` for the logins and timestamps the second pass needs to know up front. */
export function collectScrubFacts(json, fields, facts) {
  const compiled = compileFields(fields);
  const visit = (value, path) => {
    if (path !== '' && compiled.treatments.has(path)) {
      const treatment = compiled.treatments.get(path);
      for (const item of [value].flat()) {
        if (typeof item === 'string' && treatment === 'login') {
          facts.logins.push(item);
        }
        if (typeof item === 'string' && treatment === 'time') {
          facts.times.push(item);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(json, '');
}

// --- Text output -----------------------------------------------------------

const AUTH_SOURCES = new Set(['keyring', 'oauth_token', 'GH_TOKEN', 'GITHUB_TOKEN']);

function authStatusLine(line, context) {
  const indent = /^\s*/.exec(line)[0];
  const rest = line.slice(indent.length);
  if (rest === '' || rest === 'github.com') {
    return line;
  }
  const loggedIn =
    /^([✓X]) (Logged in to|Failed to log in to) github\.com account (\S+) \((\S+)\)$/.exec(rest);
  if (loggedIn) {
    const source = AUTH_SOURCES.has(loggedIn[4]) ? loggedIn[4] : 'keyring';
    return `${indent}${loggedIn[1]} ${loggedIn[2]} github.com account ${fakeLogin(context, loggedIn[3])} (${source})`;
  }
  if (
    /^- Active account: (true|false)$/.test(rest) ||
    /^- Git operations protocol: (https|ssh)$/.test(rest)
  ) {
    return line;
  }
  if (/^- Token: /.test(rest)) {
    return `${indent}- Token: gho_************************************`;
  }
  if (/^- Token scopes: /.test(rest)) {
    return `${indent}- Token scopes: 'gist', 'read:org', 'repo', 'workflow'`;
  }
  return LINE;
}

function versionLine(line) {
  return line === '' ||
    /^gh version \d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)$/.test(line) ||
    /^https:\/\/github\.com\/cli\/cli\/releases\/tag\/v\d+\.\d+\.\d+$/.test(line)
    ? line
    : LINE;
}

const ACCOUNT_LINE = /^\s*\S+ (?:Logged in to|Failed to log in to) /;

/** Keeps only the active account's block: other signed-in accounts are not the recording's business. */
function activeAccountOnly(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (ACCOUNT_LINE.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current && line.trim() !== '') {
      current.push(line);
    } else {
      current = null;
      blocks.push([line]);
    }
  }
  const kept = [];
  for (const block of blocks) {
    const inactive =
      ACCOUNT_LINE.test(block[0]) && !block.some((line) => /- Active account: true$/.test(line));
    if (!inactive) {
      kept.push(block);
    } else if (kept.at(-1)?.join('') === '') {
      // The blank line that separated the dropped block goes with it.
      kept.pop();
    }
  }
  return kept.flat();
}

const TEXT_SCRUBBERS = {
  version: (text) => text.split('\n').map(versionLine).join('\n'),
  authStatus: (text, context) =>
    activeAccountOnly(text.split('\n'))
      .map((line) => authStatusLine(line, context))
      .join('\n'),
  login: (text, context) => {
    const login = text.trim();
    return login ? `${fakeLogin(context, login)}\n` : text;
  },
  body: (text) => (text.trim() ? `${TEXT}\n` : text),
  sha: (text, context) => {
    const sha = text.trim();
    return sha ? `${treatString('sha', sha, context)}\n` : text;
  },
};

/** Scrubs a text output (stdout or stderr) by its shape's line templates. */
export function scrubText(kind, text, context) {
  const scrub = TEXT_SCRUBBERS[kind];
  if (!scrub) {
    throw new Error(`No text scrubber named ${kind}`);
  }
  return scrub(text, context);
}

/** The login in a text output, for `collectScrubFacts`' text counterpart. */
export function loginsInText(kind, text) {
  if (kind === 'login') {
    return text.trim() ? [text.trim()] : [];
  }
  if (kind === 'authStatus') {
    return [...text.matchAll(/github\.com account (\S+) \(/g)].map((match) => match[1]);
  }
  return [];
}

// --- HTTP output (`gh api --include`) ---------------------------------------

/** Splits `--include` output into status line, headers and body text. */
export function splitHttp(stdout) {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) {
    throw new Error('gh --include output has no header separator');
  }
  const head = stdout.slice(0, separator.index);
  const lineEnding = separator[0].startsWith('\r') ? '\r\n' : '\n';
  const [status = '', ...headerLines] = head.split(/\r?\n/);
  return {
    status,
    headers: headerLines.map((line) => {
      const colon = line.indexOf(':');
      return colon < 0 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
    body: stdout.slice(separator.index + separator[0].length),
    lineEnding,
  };
}

function scrubLink(value, context) {
  return value
    .split(',')
    .map((part) => {
      const match = /^\s*<([^>]*)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
      return match ? `<${fakeUrl(match[1], context)}>; rel="${match[2]}"` : PLACEHOLDER;
    })
    .join(', ');
}

const HEADER_VALUES = {
  'content-type': (value) =>
    /^application\/json(?:; charset=utf-8)?$/.test(value) ? value : PLACEHOLDER,
  link: scrubLink,
  'x-github-api-version-selected': (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : PLACEHOLDER,
};

/** Keeps the status line and the allowlisted headers, with scrubbed values. */
export function scrubHttpHead({ status, headers, lineEnding }, allowed, context) {
  const keptHeaders = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (allowed.includes(lower) && HEADER_VALUES[lower]) {
      keptHeaders.push([name, HEADER_VALUES[lower](value, context)]);
    } else {
      context.droppedKeys += 1;
    }
  }
  return {
    status: /^HTTP\/[\d.]+ \d{3}(?: [A-Za-z ]+)?$/.test(status) ? status : PLACEHOLDER,
    headers: keptHeaders,
    lineEnding,
  };
}

/** Rebuilds `gh api --include` output from a recorded head and body. */
export function joinHttp({ status, headers, lineEnding }, body) {
  return (
    [status, ...headers.map(([name, value]) => `${name}: ${value}`)].join(lineEnding) +
    lineEnding +
    lineEnding +
    body
  );
}
