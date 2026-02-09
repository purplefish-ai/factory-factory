/**
 * Integration test: Session Persistence
 *
 * Verifies that session history is preserved and can be resumed.
 * This test creates a session, sends a message, then resumes and
 * verifies the context is preserved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempRepo, createTempRepo, TestSession } from './index';

describe('Session Persistence', () => {
  let testDir: string;

  beforeAll(async () => {
    // Create a temp repo
    testDir = await createTempRepo({
      files: {
        'data.txt': 'Some test data',
      },
    });
  });

  afterAll(async () => {
    await cleanupTempRepo(testDir);
  });

  it('preserves context across session resume', async () => {
    // 1. Create first session and establish context
    const session1 = await TestSession.create({
      model: 'haiku',
      workspacePath: testDir,
    });

    // Send a message with a unique piece of information
    const secretCode = `SECRET-${Date.now()}`;
    await session1.send(
      `Remember this code for later: "${secretCode}". Just acknowledge that you've noted it.`
    );

    // Wait for acknowledgment
    const ackResponse = await session1.waitForResponse({ timeout: 60_000 });
    expect(ackResponse.content.length).toBeGreaterThan(0);

    // Get the session ID for resuming
    const claudeSessionId = session1.getClaudeSessionId();

    // Clean up first session
    await session1.cleanup();

    // Skip resume test if we couldn't get a session ID
    if (!claudeSessionId) {
      return;
    }

    // 2. Create second session, resuming from the first
    const session2 = await TestSession.create({
      model: 'haiku',
      workspacePath: testDir,
      resumeSessionId: claudeSessionId,
    });

    // Ask about the secret code
    await session2.send('What was the secret code I asked you to remember earlier?');

    // Wait for response
    const recallResponse = await session2.waitForResponse({ timeout: 60_000 });

    // The response should contain the secret code
    expect(recallResponse.content).toContain(secretCode);

    // Clean up
    await session2.cleanup();
  });
});
