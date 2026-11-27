import { describe, expect, it } from 'vitest';
import { FAKE_REPOSITORY, GH_OBJECTS, GH_SHAPES } from './gh-policies.mjs';
import {
  collectScrubFacts,
  createGhScrubContext,
  fakeUrl,
  joinHttp,
  LINE,
  PLACEHOLDER,
  scrubHttpHead,
  scrubJson,
  scrubText,
  splitHttp,
  TEXT,
  trimOutput,
} from './gh-scrub.mjs';
import { assertPublicRepository } from './gh.mjs';

// Every value here is invented for the test.
const REPOSITORY = 'some-org/some-repo';

function context(facts: { logins?: string[]; times?: string[] } = {}) {
  return createGhScrubContext({ repository: REPOSITORY, fake: FAKE_REPOSITORY, ...facts });
}

describe('scrubJson', () => {
  it('keeps only listed paths, each by its treatment, and drops every other key', () => {
    const shared = context({ logins: ['jane-doe'], times: ['2025-05-02T10:00:00Z'] });
    const scrubbed = scrubJson(
      {
        number: 42,
        title: 'Fix the thing Jane found',
        state: 'OPEN',
        author: { login: 'jane-doe', name: 'Jane Doe', id: 'MDQ6VXNlcjE=' },
        createdAt: '2025-05-02T10:00:00Z',
        unknown: { nested: 'secret' },
        comments: [{ id: 'IC_abc', body: '' }],
      },
      {
        number: 'number',
        title: 'text',
        state: 'keep',
        'author.login': 'login',
        createdAt: 'time',
        'comments.id': 'id',
        'comments.body': 'text',
      },
      shared
    );
    expect(scrubbed).toEqual({
      number: 42,
      title: TEXT,
      state: 'OPEN',
      author: { login: 'user-1' },
      createdAt: '2026-01-01T00:00:00Z',
      comments: [{ id: 'fake-node-1', body: '' }],
    });
    expect(shared.droppedKeys).toBe(3);
  });

  it('gives one id the same fake everywhere, numeric or not, and keeps it positive', () => {
    const shared = context();
    const fields = { id: 'id', fullDatabaseId: 'id' };
    expect(scrubJson({ id: 98_765, fullDatabaseId: '98765' }, fields, shared)).toEqual({
      id: 1_000_001,
      fullDatabaseId: '1000001',
    });
  });

  it('refuses to keep a string naming a login, a forbidden term or a private value', () => {
    const shared = context({ logins: ['jane-doe'] });
    const fields = { a: 'keep', b: 'keep', c: 'keep', d: 'keep', e: 'keep' };
    expect(
      scrubJson(
        {
          a: 'Build (ubuntu-latest)',
          b: 'deploy for jane-doe',
          c: 'macbook runner',
          d: 'mail jane@example.org',
          e: 'line one\nline two',
        },
        fields,
        shared
      )
    ).toEqual({
      a: 'Build (ubuntu-latest)',
      b: PLACEHOLDER,
      c: PLACEHOLDER,
      d: PLACEHOLDER,
      e: PLACEHOLDER,
    });
  });

  it('keeps timestamps in their real order', () => {
    const times = ['2025-05-03T00:00:00Z', '2025-05-01T00:00:00Z'];
    const facts = { logins: [], times: [] as string[] };
    collectScrubFacts({ t: times }, { t: 'time' }, facts);
    const scrubbed = scrubJson({ t: times }, { t: 'time' }, context(facts));
    expect(scrubbed).toEqual({ t: ['2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z'] });
  });

  it("keeps a timestamp's fraction digits and its Z or offset, never the zone itself", () => {
    const times = [
      '2025-05-01T10:00:00.123Z',
      '2025-05-02T10:00:00+02:00',
      '2025-05-03T10:00:00.5-07:00',
    ];
    const facts = { logins: [], times: [] as string[] };
    collectScrubFacts({ t: times }, { t: 'time' }, facts);
    expect(scrubJson({ t: times }, { t: 'time' }, context(facts))).toEqual({
      t: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00+00:00', '2026-01-01T00:02:00.0+00:00'],
    });
  });

  it('gives bots and apps fakes that stay bots and apps', () => {
    const shared = context();
    const fields = { a: 'login', b: 'login', c: 'login' };
    expect(scrubJson({ a: 'helper[bot]', b: 'app/helper', c: 'jane-doe' }, fields, shared)).toEqual(
      {
        a: 'bot-1[bot]',
        b: 'app/bot-2',
        c: 'user-3',
      }
    );
  });
});

describe('fakeUrl', () => {
  it('keeps path words and object numbers, fakes the repository and every other number', () => {
    const shared = context();
    expect(fakeUrl('https://github.com/some-org/some-repo/pull/42#issuecomment-555', shared)).toBe(
      'https://github.com/example-owner/example-repo/pull/42#issuecomment-1000001'
    );
    expect(fakeUrl('https://github.com/some-org/some-repo/actions/runs/77/job/88', shared)).toBe(
      'https://github.com/example-owner/example-repo/actions/runs/1000002/job/1000003'
    );
    expect(
      fakeUrl(
        'https://api.github.com/repositories/77/issues/events?per_page=100&page=2&token=x',
        shared
      )
    ).toBe('https://api.github.com/repositories/1000002/issues/events?per_page=100&page=2');
    expect(fakeUrl('https://github.com/someone-else/elsewhere/tree/main', shared)).toBe(
      'https://github.com/x/x/x/x'
    );
    expect(fakeUrl('https://ci.example.com/run/1', shared)).toBe('https://example.invalid/');
  });
});

describe('trimOutput', () => {
  it('trims each page of a --slurp read and reports what it kept', () => {
    expect(
      trimOutput(
        [
          [1, 2, 3],
          [4, 5],
        ],
        { limit: 2 }
      )
    ).toEqual({
      json: [
        [1, 2],
        [4, 5],
      ],
      kept: { kept: 4, of: 5 },
    });
  });
});

describe('scrubText', () => {
  it('keeps only the active account of auth status, with a fake login, token and scopes', () => {
    const shared = context();
    const output = [
      'github.com',
      '  ✓ Logged in to github.com account jane-doe (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      '  - Token: gho_************************************',
      "  - Token scopes: 'repo', 'admin:org'",
      '',
      '  ✓ Logged in to github.com account jane-alt (/home/jane/.config/gh/hosts.yml)',
      '  - Active account: false',
      '  - Token: gho_************************************',
      '',
      '  ! something else',
      '',
    ].join('\n');
    expect(scrubText('authStatus', output, shared)).toBe(
      [
        'github.com',
        '  ✓ Logged in to github.com account user-1 (keyring)',
        '  - Active account: true',
        '  - Git operations protocol: https',
        '  - Token: gho_************************************',
        "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
        '',
        LINE,
        '',
      ].join('\n')
    );
  });

  it('leaves no trailing blank line where the last account block was dropped', () => {
    const output = [
      'github.com',
      '  ✓ Logged in to github.com account jane-doe (keyring)',
      '  - Active account: true',
      '',
      '  ✓ Logged in to github.com account jane-alt (keyring)',
      '  - Active account: false',
      '',
    ].join('\n');
    expect(scrubText('authStatus', output, context())).toBe(
      [
        'github.com',
        '  ✓ Logged in to github.com account user-1 (keyring)',
        '  - Active account: true',
        '',
      ].join('\n')
    );
  });
});

describe('HTTP output', () => {
  it('keeps the status line and allowlisted headers, rewriting the link header', () => {
    const shared = context();
    const raw = [
      'HTTP/2.0 200 OK',
      'Content-Type: application/json; charset=utf-8',
      'Link: <https://api.github.com/repositories/77/issues/events?per_page=100&page=3>; rel="next"',
      'X-Github-Request-Id: ABCD:1234',
      'X-Oauth-Scopes: repo',
      '',
      '[]',
    ].join('\r\n');
    const head = scrubHttpHead(splitHttp(raw), ['content-type', 'link'], shared);
    expect(joinHttp(head, '[]')).toBe(
      [
        'HTTP/2.0 200 OK',
        'Content-Type: application/json; charset=utf-8',
        'Link: <https://api.github.com/repositories/1000001/issues/events?per_page=100&page=3>; rel="next"',
        '',
        '[]',
      ].join('\r\n')
    );
    expect(shared.droppedKeys).toBe(2);
  });
});

describe('GH_SHAPES', () => {
  const real = { ...GH_OBJECTS, repo: GH_OBJECTS.repository, threadId: 'T', threadCursor: 'C' };
  const fake = {
    ...real,
    repo: `${FAKE_REPOSITORY.owner}/${FAKE_REPOSITORY.name}`,
    ...FAKE_REPOSITORY,
  };

  it('run only reads', () => {
    const writes =
      /^(?:create|edit|comment|merge|close|reopen|review|delete|rerun|run|set|login|logout|refresh|token|lock|ready)$|^--(?:method|input|field|raw-field|show-token)$|^-[XFf]$/;
    for (const shape of GH_SHAPES) {
      const args = shape.args({ ...real, ...GH_OBJECTS });
      // `-f query=` is how `gh api graphql` sends a query; nothing else may use -f.
      const flags = args.filter(
        (arg, index) => !(arg === '-f' && args[index + 1]?.startsWith('query='))
      );
      expect(
        flags.filter((arg) => writes.test(arg)),
        shape.file
      ).toEqual([]);
      expect(flags.join(' '), shape.file).not.toMatch(/\bmutation\b/);
    }
  });

  it('name only the fake repository once built from fakes', () => {
    const [owner, name] = GH_OBJECTS.repository.split('/');
    for (const shape of GH_SHAPES) {
      const args = shape.args(fake).join(' ');
      expect(args, shape.file).not.toContain(owner);
      expect(args, shape.file).not.toContain(`"${name}"`);
    }
  });
});

describe('assertPublicRepository', () => {
  it('records only a repository whose visibility read says it is not private', () => {
    expect(() => assertPublicRepository({ status: 0, stdout: 'false\n' })).not.toThrow();
    for (const result of [
      { status: 0, stdout: 'true\n' },
      { status: 1, stdout: '' },
      { status: 0, stdout: '' },
      { status: null, stdout: '', error: new Error('spawn gh ENOENT') },
    ]) {
      expect(() => assertPublicRepository(result)).toThrow(/not public/);
    }
  });
});
