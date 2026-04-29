import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRatchetDispatchPrompt, clearRatchetDispatchPromptCache } from './ratchet-dispatch';

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

describe('ratchet dispatch prompt', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRatchetDispatchPromptCache();
  });

  it('injects PR context into template', () => {
    readFileSyncMock.mockReturnValue('PR Number: {{PR_NUMBER}}\nPR URL: {{PR_URL}}');
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('https://github.com/example/repo/pull/42');
    expect(prompt).toContain('PR Number: 42');
    expect(prompt).not.toContain('{{PR_URL}}');
    expect(prompt).not.toContain('{{PR_NUMBER}}');
  });

  it('falls back to built-in template when file is empty', () => {
    readFileSyncMock.mockReturnValue('');
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('Execute autonomously in this order:');
    expect(prompt).toContain('https://github.com/example/repo/pull/42');
  });

  it('requires PR comment replies by default', () => {
    readFileSyncMock.mockReturnValue(
      'Step 6: {{REVIEW_REPLY_INSTRUCTION}}\nStep 8: {{RE_REVIEW_COMMENT_INSTRUCTION}}'
    );
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('Reply to every review comment');
    expect(prompt).toContain('gh pr comment 42 --body');
  });

  it('omits PR comment replies when disabled in context', () => {
    readFileSyncMock.mockReturnValue(
      'Step 6: {{REVIEW_REPLY_INSTRUCTION}}\nStep 8: {{RE_REVIEW_COMMENT_INSTRUCTION}}'
    );
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42, [], {
      replyToPrComments: false,
    });

    expect(prompt).toContain('Do not reply on review threads for this run');
    expect(prompt).toContain('Do not post a PR comment requesting re-review for this run');
    expect(prompt).not.toContain('Reply to every review comment');
    expect(prompt).not.toContain('gh pr comment 42 --body');
  });

  it('preserves literal placeholder syntax in review comments', () => {
    readFileSyncMock.mockReturnValue(
      [
        '{{REVIEW_COMMENTS}}',
        '{{MERGE_CONFLICT_STATUS}}',
        '{{REVIEW_REPLY_INSTRUCTION}}',
        '{{RE_REVIEW_COMMENT_INSTRUCTION}}',
        '{{REVIEW_REPLY_COMPLETION}}',
        '{{RE_REVIEW_COMMENT_COMPLETION}}',
      ].join('\n')
    );
    clearRatchetDispatchPromptCache();

    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42, [
      {
        author: 'reviewer',
        body: 'I found {{MERGE_CONFLICT_STATUS}} in the logs',
        path: 'src/example.ts',
        line: 12,
        url: 'https://github.com/example/repo/pull/42#discussion_r1',
      },
    ]);

    expect(prompt).toContain('I found {{MERGE_CONFLICT_STATUS}} in the logs');
    expect(prompt).toContain('No merge conflicts detected.');
  });

  it('preserves instruction placeholder syntax in review comments', () => {
    readFileSyncMock.mockReturnValue(
      '{{REVIEW_COMMENTS}}\n{{REVIEW_REPLY_INSTRUCTION}}\n{{RE_REVIEW_COMMENT_COMPLETION}}'
    );
    clearRatchetDispatchPromptCache();

    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42, [
      {
        author: 'dev',
        body: 'Check the {{REVIEW_REPLY_INSTRUCTION}} for guidance',
        path: 'src/example.ts',
        line: null,
        url: 'https://github.com/example/repo/pull/42#discussion_r2',
      },
    ]);

    expect(prompt).toContain('Check the {{REVIEW_REPLY_INSTRUCTION}} for guidance');
    expect(prompt).toContain('Reply to every review comment');
  });
});
