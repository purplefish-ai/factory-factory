/**
 * Integration test: Tool Use - Read File
 *
 * Verifies that Claude can read files when asked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempRepo, createTempRepo, TestSession } from './index';

describe('Tool Use: Read File', () => {
  let session: TestSession;
  let testDir: string;

  beforeAll(async () => {
    // Create a temp repo with a test file
    testDir = await createTempRepo({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'test-project',
            version: '1.0.0',
            description: 'A test project for integration testing',
          },
          null,
          2
        ),
        'README.md': '# Test Project\n\nThis is a test project.',
      },
    });

    // Create a test session with the cheapest model
    session = await TestSession.create({
      model: 'haiku',
      workspacePath: testDir,
    });
  });

  afterAll(async () => {
    await session?.cleanup();
    await cleanupTempRepo(testDir);
  });

  it('reads a file when asked and returns the content', async () => {
    // Ask Claude to read the package.json file
    await session.send(
      'Read the package.json file and tell me only the "name" field value. Be very brief.'
    );

    // Wait for the Read tool to be used
    const toolUse = await session.waitForToolUse({
      name: 'Read',
      timeout: 60_000,
    });

    // Verify the tool was called with the right file
    expect(toolUse.name).toBe('Read');
    expect(toolUse.input.file_path).toContain('package.json');

    // Wait for the response with the answer
    const response = await session.waitForResponse({ timeout: 30_000 });

    // The response should contain the project name
    expect(response.content.toLowerCase()).toContain('test-project');
  });
});
