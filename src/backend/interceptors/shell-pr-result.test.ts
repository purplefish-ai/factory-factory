import { describe, expect, it } from 'vitest';
import { shellCreatedPrUrls } from './shell-pr-result';

const first = 'https://github.com/org/repo/pull/1';
const second = 'https://github.com/org/repo/pull/2';
function detect(command: string, content: string) {
  return shellCreatedPrUrls({
    toolUseId: '1',
    toolName: 'Bash',
    input: { command },
    output: { content, isError: false },
  });
}

describe('shell PR creation results', () => {
  it('returns both URLs from compound creates', () => {
    expect(
      detect('gh pr create 2>&1 | tail -1; cd other && gh pr create', `${first}\n${second}`)
    ).toEqual([first, second]);
  });
  it('recognizes the collection POST and its implicit method', () => {
    expect(detect("gh api repos/org/repo/pulls -f title=hello --jq '.html_url'", first)).toEqual([
      first,
    ]);
    expect(detect('gh api -X POST repos/org/repo/pulls', first)).toEqual([first]);
  });
  it('reads the canonical REST response field and ignores links in the body', () => {
    expect(
      detect(
        'gh api -X POST repos/org/repo/pulls',
        JSON.stringify({ body: second, html_url: first, number: 1 })
      )
    ).toEqual([first]);
  });

  it('ignores an unrelated tool whose title describes a command', () => {
    expect(
      shellCreatedPrUrls({
        toolUseId: 'a',
        toolName: 'create_issue',
        input: { title: 'gh pr create' },
        output: { content: first, isError: false },
      })
    ).toEqual([]);
  });

  it.each([
    'gh \\\n  pr \\\n create',
    'gh p\\\nr create',
    '(gh pr create)',
    '(cd other && (gh pr create))',
  ])('recognizes shell grouping and line continuations in %s', (command) => {
    expect(detect(command, first)).toEqual([first]);
  });
  it.each([
    'rg "gh pr create" log',
    "echo 'x; gh pr create'",
    "cat <<'EOF'\ngh pr create\nEOF",
    'gh api repos/org/repo/pulls -X GET -f page=1',
    'gh api repos/org/repo/pulls/1/comments -f body=x',
    'gh api --jq repos/org/repo/pulls -f title=x',
    'echo noop # gh pr create',
    'args=(gh pr create)',
  ])('ignores non-creates in %s', (command) => expect(detect(command, first)).toEqual([]));
});
