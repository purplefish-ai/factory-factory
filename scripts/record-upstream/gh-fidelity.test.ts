import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_REPOSITORY, GH_SHAPES } from './gh-policies.mjs';
import {
  collectScrubFacts,
  createGhScrubContext,
  loginsInText,
  scrubHttpHead,
  scrubJson,
  scrubText,
} from './gh-scrub.mjs';

// The gh counterpart of fidelity.test.ts: scrubs the committed gh recordings
// again with the current allowlist and fails when a value they kept would be
// lost at the next recording. The parse test
// (src/backend/services/github/service/gh-recordings.test.ts) reads only what
// the recordings keep, so a recording that survives unchanged, fakes aside,
// keeps every value it reads.

const recordingsRoot = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'backend',
  'testing',
  'fixtures',
  'upstream',
  'gh'
);
const versions = readdirSync(recordingsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name);

type Shape = (typeof GH_SHAPES)[number];
type Http = {
  head: { status: string; headers: [string, string][]; lineEnding: string };
  body: unknown;
};

// The scrubber's fakes: node ids, commits, cursors, branches, logins, numeric ids and timestamps.
const FAKES =
  /fake-(?:node|sha|cursor)-\d+|branch-\d+|user-\d+|bot-\d+|\b1\d{6}\b|2026-01-01T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)/g;

/** Fakes renumbered in order of first appearance, so handing them out again is not a change. */
function canonicalFakes(value: unknown): string {
  const seen = new Map<string, string>();
  return JSON.stringify(value, null, 1).replace(FAKES, (match) => {
    if (!seen.has(match)) {
      seen.set(match, `<fake-${seen.size}>`);
    }
    return seen.get(match) ?? match;
  });
}

function rescrub(recorded: { shape: Shape; stdout: unknown }[]) {
  const facts = { logins: [] as string[], times: [] as string[] };
  for (const { shape, stdout } of recorded) {
    if (shape.output === 'text') {
      facts.logins.push(...loginsInText(shape.text, String(stdout)));
    } else {
      const body = shape.output === 'json' ? stdout : (stdout as Http).body;
      collectScrubFacts(body, shape.fields, facts);
    }
  }
  const context = createGhScrubContext({
    repository: `${FAKE_REPOSITORY.owner}/${FAKE_REPOSITORY.name}`,
    fake: FAKE_REPOSITORY,
    ...facts,
  });
  const again = recorded.map(({ shape, stdout }) => {
    if (shape.output === 'text') {
      return scrubText(shape.text, String(stdout), context);
    }
    if (shape.output === 'json') {
      return scrubJson(stdout, shape.fields, context);
    }
    const { head, body } = stdout as Http;
    return {
      head: scrubHttpHead(head, shape.headers, context),
      body: scrubJson(body, shape.fields, context),
    };
  });
  return { again, droppedKeys: context.droppedKeys };
}

describe.each(versions)('scrubbing the gh %s recording again', (version) => {
  const recorded = GH_SHAPES.filter((shape) =>
    existsSync(join(recordingsRoot, version, shape.file))
  ).map((shape) => {
    const fixture: { stdout: unknown } = JSON.parse(
      readFileSync(join(recordingsRoot, version, shape.file), 'utf8')
    );
    return { shape, stdout: fixture.stdout };
  });

  it('reads a recording for every shape', () => {
    expect(recorded.length).toBe(GH_SHAPES.length);
  });

  it('loses no key, header or value the recording kept', () => {
    const { again, droppedKeys } = rescrub(recorded);
    expect(droppedKeys).toBe(0);
    expect(canonicalFakes(again)).toBe(canonicalFakes(recorded.map(({ stdout }) => stdout)));
  });
});
