import { expect, it } from 'vitest';
import { getNodeRuntimeIssue } from './node-runtime';

const requirement = '^24.0.0 || >=26.8.1';

it.each([
  '18.20.0',
  '23.11.1',
  '24.0.0-rc.1',
  '25.0.0',
  '26.7.9',
  '26.8.0',
  '26.8.1-rc.1',
  '26.13.0-rc.1',
  '27.0.0-nightly.1',
])('rejects unsupported Node %s with recovery steps', (version) => {
  const issue = getNodeRuntimeIssue(version, requirement);
  expect(issue).toContain(version);
  expect(issue).toContain('26.8.1');
  expect(issue).toContain('nvm install 26.8.1');
  expect(issue).toContain('nvm use 26.8.1');
  expect(issue).toContain('https://nodejs.org/');
});
it.each(['24.0.0', '24.22.0', '26.8.1', '26.8.2', '26.13.0', '27.0.0', '26.8.1+custom-build'])(
  'accepts supported Node %s',
  (version) => {
    expect(getNodeRuntimeIssue(version, requirement)).toBeUndefined();
  }
);
