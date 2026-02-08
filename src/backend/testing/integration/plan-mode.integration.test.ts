/**
 * Integration test: Plan Mode Flow
 *
 * Verifies that the plan mode workflow works correctly:
 * 1. Enter plan mode
 * 2. Claude creates a plan
 * 3. User accepts the plan
 * 4. Claude executes the plan
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempRepo, createTempRepo, fileExists, readTestFile, TestSession } from './index';

describe('Plan Mode Flow', () => {
  let session: TestSession;
  let testDir: string;

  beforeAll(async () => {
    // Create a temp repo with some initial files
    testDir = await createTempRepo({
      files: {
        'README.md': '# My Project\n\nA simple project.',
        'src/.gitkeep': '',
      },
    });

    // Create a test session
    session = await TestSession.create({
      model: 'haiku',
      workspacePath: testDir,
    });
  });

  afterAll(async () => {
    await session?.cleanup();
    await cleanupTempRepo(testDir);
  });

  it('completes a full plan mode cycle', async () => {
    // 1. Ask Claude to create a plan for a simple task
    await session.send(
      'I want you to create a file called "greeting.txt" with the content "Hello from Plan Mode!". ' +
        'Please create a brief plan first, then I will tell you to proceed.'
    );

    // 2. Wait for Claude to respond with a plan
    const planResponse = await session.waitForResponse({ timeout: 60_000 });

    // The response should mention the plan or the file
    expect(planResponse.content.toLowerCase()).toMatch(/plan|greeting|file|create/i);

    // Clear messages for the next step
    session.clearMessages();

    // 3. Accept the plan and ask Claude to proceed
    await session.send('Looks good. Please proceed with creating the file.');

    // 4. Wait for the Write tool to be used
    const toolUse = await session.waitForToolUse({
      name: 'Write',
      timeout: 60_000,
    });

    expect(toolUse.name).toBe('Write');
    expect(toolUse.input.file_path).toContain('greeting.txt');

    // 5. Wait for completion
    await session.waitForTurnComplete({ timeout: 30_000 });

    // 6. Verify the file was created
    const exists = await fileExists(testDir, 'greeting.txt');
    expect(exists).toBe(true);

    const content = await readTestFile(testDir, 'greeting.txt');
    expect(content).not.toBeNull();
    expect(content?.toLowerCase()).toContain('hello');
  });
});
