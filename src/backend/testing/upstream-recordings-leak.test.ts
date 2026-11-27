import { readdirSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Recordings of the real Claude and Codex tools are published with the
// repository. This test fails when one carries a home directory, an account or
// machine name, an email address, a token-shaped string or a UUID that is not
// one of the scrubber's fixed fakes. Failures name the file, line and rule,
// never the matched value.

const recordingsRoot = join(import.meta.dirname, 'fixtures', 'upstream');
const forbidden = z
  .object({
    terms: z.array(z.string().min(3)),
    genericAccountNames: z.array(z.string()),
    patterns: z.array(z.object({ name: z.string(), source: z.string() })),
  })
  .parse(
    JSON.parse(
      readFileSync(join(import.meta.dirname, 'upstream-recordings-forbidden.json'), 'utf8')
    )
  );

// Whoever runs the test adds their own account and machine names, unless they
// are generic ones (a CI runner, a container's root), which match ordinary words.
const generic = new Set(forbidden.genericAccountNames);
const localTerms = [userInfo().username, hostname().split('.')[0] ?? ''].filter(
  (term) => term.length >= 4 && !generic.has(term.toLowerCase())
);
const termRule = (name: string, term: string) => ({
  name,
  test: (line: string) => line.toLowerCase().includes(term.toLowerCase()),
});
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FAKE_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;
const rules = [
  ...forbidden.terms.map((term, index) => termRule(`forbidden term #${index}`, term)),
  ...localTerms.map((term) => termRule('local account or machine name', term)),
  ...forbidden.patterns.map(({ name, source }) => {
    const pattern = new RegExp(source, 'i');
    return { name, test: (line: string) => pattern.test(line) };
  }),
  {
    name: 'UUID that is not a fixed fake',
    test: (line: string) => (line.match(UUID) ?? []).some((uuid) => !FAKE_UUID.test(uuid)),
  },
];

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]
  );
}

describe('upstream recordings', () => {
  const files = listFiles(recordingsRoot);

  it('exist for both providers', () => {
    const tools = new Set(files.map((file) => relative(recordingsRoot, file).split(/[\\/]/)[0]));
    expect([...tools].sort()).toEqual(['claude', 'codex']);
  });

  it('carry no private values', () => {
    const findings: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const rule of rules) {
            if (rule.test(line)) {
              findings.push(`${relative(recordingsRoot, file)}:${index + 1} ${rule.name}`);
            }
          }
        });
    }
    expect(findings).toEqual([]);
  });

  it('detect every kind of forbidden value', () => {
    const invented = [
      '/Users/someone/project',
      '/home/someone/project',
      '%2FUsers%2Fsomeone%2Fproject',
      'Contact jane.doe@example.org',
      'key sk-abcdefghijklmnop',
      'Authorization: Bearer abc',
      'authorization: bearer abc',
      'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
      'token ghp_ABCDEFGHIJKLMNOPQRST0123',
      'token github_pat_11ABCDEFG0123456789_abc',
      'slack xoxb-1234567890-abcdef',
      'aws AKIAABCDEFGHIJKLMNOP',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w',
      'commit 0123456789abcdef0123456789abcdef01234567',
      '/var/folders/xy/abc/T/recording',
      '/private/tmp/recording',
      'host.example-tailnet.ts.net',
      '"sessionId":"3f2b8c1e-9a7d-4e6f-b5c4-1d2e3f4a5b6c"',
    ];
    for (const sample of invented) {
      expect(
        rules.some((rule) => rule.test(sample)),
        sample
      ).toBe(true);
    }
    expect(rules.some((rule) => rule.test('"id":"00000000-0000-4000-8000-00000000000a"'))).toBe(
      false
    );
  });
});
