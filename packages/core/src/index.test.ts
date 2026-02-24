import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('@factory-factory/core', () => {
  it('can be imported', () => {
    expect(core).toBeDefined();
  });

  it('exports IssueProvider', () => {
    expect(core.IssueProvider).toBeDefined();
    expect(core.IssueProvider.GITHUB).toBe('GITHUB');
    expect(core.IssueProvider.LINEAR).toBe('LINEAR');
  });
});
