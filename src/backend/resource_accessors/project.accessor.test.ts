import { describe, expect, it } from 'vitest';
import { parseGitHubRemoteUrl } from './project.accessor';

describe('parseGitHubRemoteUrl', () => {
  describe('SSH URLs', () => {
    it('should parse standard SSH URL with .git suffix', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse SSH URL without .git suffix', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should handle organization names with hyphens', () => {
      const result = parseGitHubRemoteUrl('git@github.com:my-org/my-repo.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('should handle repo names with dots', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo.name.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo.name' });
    });

    it('should handle repo names with underscores', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/my_repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'my_repo' });
    });
  });

  describe('HTTPS URLs', () => {
    it('should parse standard HTTPS URL with .git suffix', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTPS URL without .git suffix', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTP URL (not HTTPS)', () => {
      const result = parseGitHubRemoteUrl('http://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should handle organization names with hyphens', () => {
      const result = parseGitHubRemoteUrl('https://github.com/my-org/my-repo.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('should handle repo names with dots', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo.name.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo.name' });
    });
  });

  describe('Non-GitHub URLs', () => {
    it('should return null for GitLab SSH URL', () => {
      const result = parseGitHubRemoteUrl('git@gitlab.com:owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for GitLab HTTPS URL', () => {
      const result = parseGitHubRemoteUrl('https://gitlab.com/owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for Bitbucket URL', () => {
      const result = parseGitHubRemoteUrl('git@bitbucket.org:owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for self-hosted Git URL', () => {
      const result = parseGitHubRemoteUrl('git@git.company.com:owner/repo.git');
      expect(result).toBeNull();
    });
  });

  describe('Invalid URLs', () => {
    it('should return null for empty string', () => {
      const result = parseGitHubRemoteUrl('');
      expect(result).toBeNull();
    });

    it('should return null for malformed URL', () => {
      const result = parseGitHubRemoteUrl('not-a-url');
      expect(result).toBeNull();
    });

    it('should return null for URL without repo', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner');
      expect(result).toBeNull();
    });

    it('should return null for URL with extra path segments', () => {
      // This is technically valid GitHub URL structure but we only want owner/repo
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo/tree/main');
      expect(result).toBeNull();
    });
  });
});
