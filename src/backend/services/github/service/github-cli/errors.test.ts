import { describe, expect, it } from 'vitest';
import { classifyError, getGitHubCLIDiagnostic, wrapGitHubCLIError } from './errors';

function execFailure(command: string, stderr: string) {
  return Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { stderr });
}

describe('GitHub CLI error wrapping', () => {
  it('never repeats the command line, even when gh writes no stderr', () => {
    const failure = execFailure('gh pr comment 2 --repo o/r --body line one\nsecret line two', '');
    const wrapped = wrapGitHubCLIError('Failed to add PR comment', failure);
    expect(wrapped.message).toBe('Failed to add PR comment: gh command failed');
    expect(wrapped.cause).toBe(failure);
    expect(getGitHubCLIDiagnostic(failure)).not.toMatch(/secret|--body/);
  });

  it('keeps gh diagnostics and non-process error messages', () => {
    expect(getGitHubCLIDiagnostic(execFailure('gh issue list', 'HTTP 502: Bad Gateway\n'))).toBe(
      'HTTP 502: Bad Gateway'
    );
    expect(getGitHubCLIDiagnostic(new Error('Invalid gh CLI response for listIssues'))).toBe(
      'Invalid gh CLI response for listIssues'
    );
  });

  it('classifies wrapped failures by the diagnostic, not the command arguments', () => {
    const outage = execFailure('gh issue list --repo o/authentication-service', 'HTTP 502');
    expect(classifyError(wrapGitHubCLIError('Failed to list issues', outage))).toBe('unknown');
    const auth = execFailure('gh issue list --repo o/r', 'HTTP 401: Bad credentials');
    expect(classifyError(wrapGitHubCLIError('Failed to list issues', auth))).toBe('auth_required');
  });
});
