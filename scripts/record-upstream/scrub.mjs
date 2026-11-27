// Allowlist scrubber for upstream recordings (see scripts/record-upstream.mjs).
//
// A recording is published in a public repository, so nothing is kept because
// it "looks safe". What may survive is named in ./policies.mjs, by record kind
// and key path; a record kind that is not named there is opaque. Everything
// else is replaced:
//
// - strings become "<string>", numbers 0; booleans and null are kept;
// - an object key survives only when it is a known field name
//   (./known-keys.json), an id, or a plain name in a listed map; any other key
//   becomes "<key>" (numbered when an object has several);
// - UUIDs map to fixed fake UUIDs and ids with a known prefix (`toolu_…`,
//   `msg_…`, `exec-<uuid>`) to fixed fakes with that prefix (and length, up to
//   24 characters); an id with any other prefix becomes `id_<fake>`; ISO
//   timestamps map to a fixed sequence. References between records still line
//   up;
// - outside conversation text, an absolute path survives only under the
//   throwaway repository (`/workspace`), the recording's temp directory
//   (`/recording-tmp`) or Claude's own project directory for the session;
// - conversation text keeps the recorder's prompts and the model's replies,
//   with known roots rewritten and any other home directory made
//   `/user-home`; text that still looks private becomes "<redacted>".
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { POLICIES } from './policies.mjs';

export { POLICIES };

export const PLACEHOLDER_STRING = '<string>';
export const PLACEHOLDER_NUMBER = 0;
export const PLACEHOLDER_KEY = '<key>';
export const HOME_PLACEHOLDER = '/user-home';
/** Text that still looked private after rewriting; the recorder reports how many. */
export const REDACTED = '<redacted>';

const KNOWN_KEYS = new Set(createRequire(import.meta.url)('./known-keys.json'));

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const UUID_GLOBAL = new RegExp(UUID_SOURCE, 'gi');
// A UUID behind a short prefix, as in `exec-<uuid>` or `msg_<uuid>`.
const PREFIXED_UUID = new RegExp(`^([A-Za-z][A-Za-z0-9]{0,15}[-_])(${UUID_SOURCE})$`, 'i');
// An id body has a digit; `input_transformations` is a key, not an id.
const PREFIXED_ID = /^([a-z]{2,12}_)((?=[A-Za-z]*\d)[A-Za-z0-9]{12,})$/;
// Prefixes the tools use for their own ids. Any other prefix may be a name.
const ID_PREFIXES = new Set([
  'toolu_',
  'srvtoolu_',
  'msg_',
  'req_',
  'call_',
  'resp_',
  'ctc_',
  'ctco_',
  'at_',
  'exec-',
  'fc_',
  'rs_',
  'item_',
  'turn_',
  'retained_',
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'`<>]+/;
const HOME_PATH_GLOBAL = new RegExp(HOME_PATH.source, 'g');
const EMAIL = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PRIVATE_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bbearer\s/i,
  /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bnpm_[A-Za-z0-9]{20,}/,
  /[A-Za-z0-9+/]{40,}/,
  /[0-9a-f]{32,}/i,
  /%2F(?:Users|home)%2F/i,
  /\/var\/folders\//,
  /\/private\/(?:tmp|var)\//,
];
// Placeholders a rewritten path may start with outside conversation text.
const PATH_SURVIVORS = [
  /^\/workspace(?:\/|$)/,
  /^\/recording-tmp(?:\/|$)/,
  /^\/user-home\/\.claude(?:\/projects(?:\/-workspace(?:\/[^/]*)*\/?)?)?\/?$/,
];
// Discriminators an opaque record keeps at its top level, when they look like one.
const OPAQUE_KEEP = new Set(['type', 'subtype', 'role', 'kind', 'status', 'operation']);
const DISCRIMINATOR = /^[A-Za-z0-9_.:/-]{1,64}$/;
const MAP_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FAKE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const MAX_KEPT_LENGTH = 200;
const MAX_FAKE_ID_BODY = 24;

function matcher(paths) {
  const exact = new Set(paths.filter((path) => !path.includes('*')));
  const patterns = paths
    .filter((path) => path.includes('*'))
    .map(
      (path) =>
        new RegExp(
          `^${path
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^.>]+')}$`
        )
    );
  return (path) => exact.has(path) || patterns.some((pattern) => pattern.test(path));
}

function compile(policy, kind) {
  const own = policy.kinds[kind];
  const parts = own ? [policy.common, own] : [policy.common];
  const join = (name) => parts.flatMap((part) => part[name]);
  return {
    opaque: !own,
    keep: matcher(join('keep')),
    ids: matcher(join('ids')),
    text: matcher(join('text')),
    numbers: matcher(join('numbers')),
    maps: matcher(join('maps')),
    words: join('words').map(({ paths, allowed }) => ({
      match: matcher(paths),
      allowed: new Set(allowed),
    })),
  };
}

const compiled = new WeakMap();
function rulesFor(policy, kind) {
  let byKind = compiled.get(policy);
  if (!byKind) {
    byKind = new Map();
    compiled.set(policy, byKind);
  }
  if (!byKind.has(kind)) {
    byKind.set(kind, compile(policy, kind));
  }
  return byKind.get(kind);
}

/**
 * Per-recording state: the path roots to rewrite, the fakes already handed
 * out (one original always maps to the same fake) and the requests seen, so a
 * response is scrubbed by the request it answers. `roots` maps an absolute
 * path to its placeholder, for example the throwaway repository to
 * `/workspace`.
 */
export function createScrubContext({ roots = {} } = {}) {
  const pairs = [];
  for (const [from, to] of Object.entries(roots)) {
    if (from.length < 2) {
      continue;
    }
    pairs.push([from, to]);
    // Claude names its project directory after the cwd with every
    // non-alphanumeric character replaced by '-'.
    pairs.push([from.replace(/[^A-Za-z0-9]/g, '-'), to.replace(/[^A-Za-z0-9]/g, '-')]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return {
    roots: pairs,
    uuids: new Map(),
    ids: new Map(),
    timestamps: new Map(),
    requests: new Map(),
    redactions: 0,
  };
}

function fakeUuid(context, original) {
  const key = original.toLowerCase();
  let fake = context.uuids.get(key);
  if (!fake) {
    const n = context.uuids.size + 1;
    fake = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    context.uuids.set(key, fake);
  }
  return fake;
}

function fakeId(context, prefix, body) {
  const original = prefix + body;
  let fake = context.ids.get(original);
  if (!fake) {
    const n = context.ids.size + 1;
    // At most 24 characters, so a fake never looks like a token to the leak test.
    fake = prefix + `Fake${n}`.padStart(Math.min(body.length, MAX_FAKE_ID_BODY), '0');
    context.ids.set(original, fake);
  }
  return fake;
}

function fakeTimestamp(context, original) {
  let fake = context.timestamps.get(original);
  if (!fake) {
    fake = new Date(FAKE_EPOCH + context.timestamps.size * 1000).toISOString();
    context.timestamps.set(original, fake);
  }
  return fake;
}

/** The fixed fake for an id-shaped string, or null when the string is not an id. */
function fakeIdentifier(value, context) {
  if (UUID.test(value)) {
    return fakeUuid(context, value);
  }
  const prefixedUuid = PREFIXED_UUID.exec(value);
  if (prefixedUuid) {
    const prefix = ID_PREFIXES.has(prefixedUuid[1]) ? prefixedUuid[1] : 'id-';
    return prefix + fakeUuid(context, prefixedUuid[2]);
  }
  const prefixed = PREFIXED_ID.exec(value);
  // A credential (`ghp_…`, `npm_…`) is not an id: it is redacted, not faked.
  if (!prefixed || looksPrivate(value)) {
    return null;
  }
  return ID_PREFIXES.has(prefixed[1])
    ? fakeId(context, prefixed[1], prefixed[2])
    : fakeId(context, 'id_', prefixed[1] + prefixed[2]);
}

/** Rewrites known roots, then any other home directory, then embedded UUIDs. */
export function rewritePaths(value, context) {
  let result = value;
  for (const [from, to] of context.roots) {
    result = result.split(from).join(to);
  }
  return result
    .replace(HOME_PATH_GLOBAL, HOME_PLACEHOLDER)
    .replace(UUID_GLOBAL, (uuid) => fakeUuid(context, uuid));
}

/** True when a string still carries something that must never be published. */
export function looksPrivate(value) {
  return (
    HOME_PATH.test(value) || EMAIL.test(value) || PRIVATE_SHAPES.some((shape) => shape.test(value))
  );
}

// An absolute path survives only when, once normalised (so `..` cannot step
// out), it lies inside a known root and its placeholder is an approved one.
function survivingPath(value, context) {
  if (!value.startsWith('/')) {
    return null;
  }
  const normal = posix.normalize(value);
  const inRoot = context.roots.some(
    ([from]) => from.startsWith('/') && (normal === from || normal.startsWith(`${from}/`))
  );
  if (!inRoot) {
    return null;
  }
  const path = rewritePaths(normal, context);
  return PATH_SURVIVORS.some((survivor) => survivor.test(path)) && !looksPrivate(path)
    ? path
    : null;
}

/** A random identifier (an SDK request id, a chunk id) becomes a stable fake. */
function fakeOpaqueId(context, value) {
  const original = `opaque:${value}`;
  let fake = context.ids.get(original);
  if (!fake) {
    fake = `fake-${context.ids.size + 1}`;
    context.ids.set(original, fake);
  }
  return fake;
}

function childPath(path, key) {
  return path === '' || path.endsWith('>') ? `${path}${key}` : `${path}.${key}`;
}

function parsedJson(value) {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function scrubText(value, path, rules, context) {
  const json = parsedJson(value);
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return JSON.stringify(scrubNode(json, `${path}>`, '', rules, context));
  }
  const text = rewritePaths(value, context);
  if (looksPrivate(text)) {
    context.redactions += 1;
    return REDACTED;
  }
  return text;
}

function scrubString(value, path, key, rules, context) {
  const fake = fakeIdentifier(value, context);
  if (fake !== null) {
    return fake;
  }
  if (ISO_TIMESTAMP.test(value)) {
    return fakeTimestamp(context, value);
  }
  if (rules.ids(path)) {
    return fakeOpaqueId(context, value);
  }
  const words = rules.words.find(({ match }) => match(path));
  if (words) {
    return words.allowed.has(value) ? value : PLACEHOLDER_STRING;
  }
  if (rules.text(path)) {
    return scrubText(value, path, rules, context);
  }
  if (rules.keep(path)) {
    if (value.startsWith('/')) {
      return survivingPath(value, context) ?? PLACEHOLDER_STRING;
    }
    const kept = rewritePaths(value, context);
    return kept.length <= MAX_KEPT_LENGTH && !looksPrivate(kept) ? kept : PLACEHOLDER_STRING;
  }
  // An opaque record keeps its own discriminators, at the top level only.
  const topLevel = !path.includes('.') && !path.includes('>');
  if (
    rules.opaque &&
    topLevel &&
    OPAQUE_KEEP.has(key) &&
    DISCRIMINATOR.test(value) &&
    !looksPrivate(value)
  ) {
    return value;
  }
  return survivingPath(value, context) ?? PLACEHOLDER_STRING;
}

function scrubKey(key, inMap, context, used) {
  const fake = fakeIdentifier(key, context);
  if (fake !== null) {
    return fake;
  }
  if (inMap ? MAP_KEY.test(key) && !looksPrivate(key) : KNOWN_KEYS.has(key)) {
    return key;
  }
  let placeholder = PLACEHOLDER_KEY;
  for (let n = 2; used.has(placeholder); n += 1) {
    placeholder = `<key-${n}>`;
  }
  return placeholder;
}

function scrubNode(value, path, key, rules, context) {
  if (typeof value === 'string') {
    return scrubString(value, path, key, rules, context);
  }
  if (typeof value === 'number') {
    return rules.numbers(path) ? value : PLACEHOLDER_NUMBER;
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubNode(item, path, key, rules, context));
  }
  if (typeof value === 'object') {
    const inMap = !rules.opaque && rules.maps(path);
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      const scrubbedKey = scrubKey(childKey, inMap, context, new Set(Object.keys(result)));
      const known = scrubbedKey === childKey || inMap;
      // A replaced key's subtree matches no rule.
      const segment = inMap ? '*' : known ? childKey : '\u0000';
      result[scrubbedKey] = scrubNode(child, childPath(path, segment), childKey, rules, context);
    }
    return result;
  }
  return PLACEHOLDER_STRING;
}

/**
 * Returns a copy of one recorded message or history line that keeps only what
 * `policy` names for its kind. `dir` is the direction it travelled, which a
 * JSON-RPC response needs to find its request.
 */
export function scrubRecord(record, policy, context, dir) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return scrubNode(record, '', '', rulesFor(policy, '\u0000unknown'), context);
  }
  const rules = rulesFor(policy, policy.kindOf(record, { dir, requests: context.requests }));
  return scrubNode(record, '', '', rules, context);
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The adapter also runs `claude auth status --json` through the stdio wrapper.
// Its pretty-printed output spans several lines and can interleave with the
// session's stream-json, so consecutive non-JSON lines are joined first.
function joinMultilineOutput(records) {
  const joined = [];
  for (const record of records) {
    const previous = joined.at(-1);
    if (record.dir !== 'argv' && !parseJson(record.line).ok) {
      if (previous?.multiline && previous.dir === record.dir) {
        previous.line += `\n${record.line}`;
      } else {
        joined.push({ ...record, multiline: true });
      }
    } else {
      joined.push(record);
    }
  }
  return joined;
}

/**
 * CLI flags and plain words (subcommands, formats) are structural; any other
 * argument may be a path, an id or JSON configuration. A flag's `=value` goes.
 */
export function scrubArgument(arg) {
  if (arg.startsWith('--')) {
    return arg.split('=')[0];
  }
  return /^[a-z][a-z-]*$/.test(arg) ? arg : PLACEHOLDER_STRING;
}

/**
 * Scrubs captured `{ dir, line }` records (and `{ dir: 'argv', args }`) into
 * `{ dir, message }` records, in order. A line that is not JSON becomes
 * "<string>".
 */
export function scrubCapturedLines(records, policy, context) {
  return joinMultilineOutput(records).map((record) => {
    if (record.dir === 'argv') {
      return { dir: 'argv', args: record.args.map(scrubArgument) };
    }
    const parsed = parseJson(record.line);
    return {
      dir: record.dir,
      message: parsed.ok
        ? scrubRecord(parsed.value, policy, context, record.dir)
        : PLACEHOLDER_STRING,
    };
  });
}
