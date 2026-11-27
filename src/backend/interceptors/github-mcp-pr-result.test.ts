import { expect, it } from 'vitest';
import { getGithubMcpCreatedPrUrl } from './github-mcp-pr-result';

const url = 'https://github.com/example/project/pull/42';
const referenced = 'https://github.com/example/project/pull/41';
const result = {
  content: [{ type: 'text', text: referenced }],
  structuredContent: { body: referenced, url },
};
const event = {
  toolUseId: 'create-42',
  toolName: 'mcp.codex_apps.github.create_pull_request',
  input: { server: 'codex_apps', tool: 'github.create_pull_request' },
  output: { isError: false, content: JSON.stringify({ result }) },
};

it('takes the created PR from the dotted connector result even when the body cites another PR', () => {
  expect(getGithubMcpCreatedPrUrl(event)).toBe(url);
});
it('ignores dotted create operations from other servers', () => {
  expect(
    getGithubMcpCreatedPrUrl({ ...event, input: { ...event.input, server: 'custom' } })
  ).toBeNull();
});
it('ignores links in prose returned by failed create operations', () => {
  expect(
    getGithubMcpCreatedPrUrl({ ...event, output: { isError: true, content: url } })
  ).toBeNull();
});

it('reads structured results from the completion aggregated output', () => {
  expect(
    getGithubMcpCreatedPrUrl({
      ...event,
      output: undefined,
      input: {
        ...event.input,
        aggregatedOutput: JSON.stringify({ result }),
      },
    })
  ).toBe(url);
});
