// Register the shared mocks before any service or orchestrator module loads.
import './workspace-init.test-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { githubCLIService } from '@/backend/services/github';
import { sessionDataService, sessionDomainService } from '@/backend/services/session';
import { SessionStatus } from '@/shared/core';
import { buildIssueStartPrompt } from '@/shared/issue-start-prompt';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  initializeWorkspaceWorktree,
} from './workspace-init.orchestrator';
import { setupHappyPath, WORKSPACE_ID } from './workspace-init.test-harness';

const enqueueInitialMessage = vi.mocked(sessionDomainService.enqueueInitialMessage);

async function initializeWithSavedPrompt(initialPrompt: string) {
  setupHappyPath({
    githubIssueNumber: 42,
    creationMetadata: {
      issueNumber: 42,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      initialPrompt,
    },
  });
  vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
    unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
  ]);
  enqueueInitialMessage.mockReturnValue({ position: 0 });

  await initializeWorkspaceWorktree(WORKSPACE_ID);
}

describe('saved initial prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkspaceInitOrchestratorStateForTests();
  });

  it('delivers a saved prompt containing closing tags verbatim', async () => {
    await initializeWithSavedPrompt('Fix the unclosed </div> in Header.tsx');

    expect(githubCLIService.getIssue).not.toHaveBeenCalled();
    expect(enqueueInitialMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ text: 'Fix the unclosed </div> in Header.tsx' })
    );
  });

  it('delivers the edited issue launch prompt verbatim', async () => {
    const launchPrompt = buildIssueStartPrompt({ url: 'https://github.com/owner/repo/issues/42' });
    const editedPrompt = `${launchPrompt}\n\nFocus on the save handler.`;

    await initializeWithSavedPrompt(editedPrompt);

    const delivered = enqueueInitialMessage.mock.calls[0]?.[1]?.text ?? '';
    expect(delivered).toBe(editedPrompt);
  });
});
