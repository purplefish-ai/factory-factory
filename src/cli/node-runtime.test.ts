import { expect, it } from 'vitest';
import { getNodeRuntimeIssue } from './node-runtime';

it.each(['18.20.0', '26.11.9', '26.12.0', '26.12.1-rc.1'])(
  'rejects unsupported Node %s with recovery steps',
  (version) => {
    const issue = getNodeRuntimeIssue(version, '>=26.12.1');
    expect(issue).toContain(version);
    expect(issue).toContain('26.12.1');
    expect(issue).toContain('nvm install 26.12.1');
    expect(issue).toContain('nvm use 26.12.1');
    expect(issue).toContain('https://nodejs.org/');
  }
);
it.each(['26.12.1', '26.12.2', '26.13.0', '27.0.0'])('accepts supported Node %s', (version) => {
  expect(getNodeRuntimeIssue(version, '>=26.12.1')).toBeUndefined();
});
