import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// `.claude/settings.json` is shared with everyone who opens this public
// repository in Claude Code, including outside contributors. It may pre-approve
// read-only and verification commands only. Adding a permission means changing
// this list in the same pull request, where a reviewer sees it.
//
// Matching, from https://code.claude.com/docs/en/permissions: a rule with no
// `*` matches one exact command; a trailing ` *` (with the space) matches the
// command and any arguments after it, but not a longer command name, so
// `pnpm test *` does not match `pnpm test:e2e:mobile`. Wildcard rules approve
// every argument, so they are used only where no argument writes outside the
// working tree. `git diff` and `git log` are exact because
// `git diff --output=<file>` and `git log --output=<file>` write a file.
const EXPECTED_ALLOW = [
  // Verification. Exact rules: `check:fix` and the `:update` scripts rewrite
  // files and must not match.
  'Bash(pnpm check)',
  'Bash(pnpm check:env)',
  'Bash(pnpm check:file-length)',
  'Bash(pnpm check:fk-indexes)',
  'Bash(pnpm check:format)',
  'Bash(pnpm check:guidance)',
  'Bash(pnpm check:imports)',
  'Bash(pnpm check:lint-suppressions)',
  'Bash(pnpm check:markdown)',
  'Bash(pnpm check:ownership)',
  'Bash(pnpm check:unused-code)',
  'Bash(pnpm knip)',
  'Bash(pnpm lint)',
  'Bash(pnpm test *)',
  'Bash(pnpm typecheck)',
  // Throwaway sandbox under the OS temp directory; no credentials reach it.
  'Bash(pnpm dev:sandbox *)',
  // Read-only git.
  'Bash(git diff)',
  'Bash(git log)',
  'Bash(git status)',
  // Read-only GitHub CLI.
  'Bash(gh pr checks *)',
  'Bash(gh pr list *)',
  'Bash(gh pr view *)',
  'Bash(gh run list *)',
  'Bash(gh run view *)',
];

const FORBIDDEN_WORDS = ['push', 'merge', 'publish', 'rm ', 'curl', 'api', '--force'];

const settingsSchema = z
  .object({
    permissions: z.object({ allow: z.array(z.string()) }).strict(),
  })
  .strict();

function readSettings() {
  const path = resolve(import.meta.dirname, '..', '.claude', 'settings.json');
  return settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

describe('.claude/settings.json', () => {
  it('holds only a permissions.allow array of strings', () => {
    expect(() => readSettings()).not.toThrow();
  });

  it('allows exactly the reviewed read-only and verification commands', () => {
    const { allow } = readSettings().permissions;
    expect([...allow].sort()).toEqual([...EXPECTED_ALLOW].sort());
  });

  it('lists every command once', () => {
    const { allow } = readSettings().permissions;
    expect(new Set(allow).size).toBe(allow.length);
  });

  it('names no command that writes, pushes, merges, publishes or sends', () => {
    const { allow } = readSettings().permissions;
    const offenders = allow.filter((entry) =>
      FORBIDDEN_WORDS.some((word) => entry.toLowerCase().includes(word))
    );
    expect(offenders).toEqual([]);
  });
});
