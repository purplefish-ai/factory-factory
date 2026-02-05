import { describe, expect, it } from 'vitest';
import type { GitHubComment } from '@/shared/github-types';

/**
 * Tests for comment filtering logic used in ratchet service
 */
describe('Ratchet Comment Detection', () => {
  const lastCheckedAt = new Date('2024-01-01T12:00:00Z').getTime();

  describe('New comment detection', () => {
    it('should detect comments created after lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'New comment',
        createdAt: '2024-01-01T13:00:00Z', // 1 hour after lastCheckedAt
        updatedAt: '2024-01-01T13:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(true);
    });

    it('should not detect comments created before lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Old comment',
        createdAt: '2024-01-01T11:00:00Z', // 1 hour before lastCheckedAt
        updatedAt: '2024-01-01T11:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });
  });

  describe('Edited comment detection', () => {
    it('should detect comments edited after lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Edited comment',
        createdAt: '2024-01-01T11:00:00Z', // Created before lastCheckedAt
        updatedAt: '2024-01-01T13:00:00Z', // Edited after lastCheckedAt
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(true);
    });

    it('should detect comments with updatedAt exactly equal to lastCheckedAt as not new', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Comment at boundary',
        createdAt: '2024-01-01T11:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z', // Exactly at lastCheckedAt
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });

    it('should not detect old unedited comments', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Old unedited comment',
        createdAt: '2024-01-01T10:00:00Z', // Before lastCheckedAt
        updatedAt: '2024-01-01T10:00:00Z', // Not edited (same as created)
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });
  });

  describe('Reviewer filtering with edited comments', () => {
    it('should apply reviewer filter to edited comments', () => {
      const allowedReviewers = ['reviewer1', 'reviewer2'];
      const filterByReviewer = allowedReviewers.length > 0;

      const comments: GitHubComment[] = [
        {
          id: '1',
          author: { login: 'reviewer1' },
          body: 'Allowed reviewer edit',
          createdAt: '2024-01-01T11:00:00Z',
          updatedAt: '2024-01-01T13:00:00Z', // Edited after lastCheckedAt
          url: 'https://github.com/test/pr/1',
        },
        {
          id: '2',
          author: { login: 'reviewer3' },
          body: 'Disallowed reviewer edit',
          createdAt: '2024-01-01T11:00:00Z',
          updatedAt: '2024-01-01T13:00:00Z', // Edited after lastCheckedAt
          url: 'https://github.com/test/pr/2',
        },
      ];

      const filteredComments = comments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      expect(filteredComments).toHaveLength(1);
      expect(filteredComments[0].author.login).toBe('reviewer1');
    });
  });
});
