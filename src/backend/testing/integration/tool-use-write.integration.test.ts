/**
 * Integration test: Tool Use - Write File
 *
 * Verifies that Claude can create and write files when asked.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempRepo, createTempRepo, fileExists, readTestFile, TestSession } from './index';

describe('Tool Use: Write File', () => {
  let session: TestSession;
  let testDir: string;

  beforeAll(async () => {
    // Create a temp repo (empty, we'll ask Claude to create files)
    testDir = await createTempRepo({
      files: {
        '.gitkeep': '', // Just to have something committed
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

  it('creates a new file when asked', async () => {
    // Ask Claude to create a simple file
    await session.send(
      'Create a file called "hello.txt" with the exact content "Hello, World!" (nothing else). Do not add any extra text or newlines.'
    );

    // Wait for the Write tool to be used
    const toolUse = await session.waitForToolUse({
      name: 'Write',
      timeout: 60_000,
    });

    // Verify the tool was called correctly
    expect(toolUse.name).toBe('Write');
    expect(toolUse.input.file_path).toContain('hello.txt');

    // Wait for the turn to complete
    await session.waitForTurnComplete({ timeout: 30_000 });

    // Verify the file was actually created on disk
    const exists = await fileExists(testDir, 'hello.txt');
    expect(exists).toBe(true);

    // Verify the content
    const content = await readTestFile(testDir, 'hello.txt');
    expect(content).not.toBeNull();
    expect(content?.trim()).toContain('Hello');
  });

  it('can modify an existing file', async () => {
    // First, create a file manually
    await fs.writeFile(path.join(testDir, 'counter.txt'), 'count: 0', 'utf-8');

    // Clear messages from previous test
    session.clearMessages();

    // Ask Claude to update the file
    await session.send(
      'Read counter.txt, then update it to say "count: 1" instead of "count: 0". Use the Edit tool if available, otherwise use Write.'
    );

    // Wait for either Edit or Write tool
    const response = await session.waitForResponse({ timeout: 60_000 });

    // Should have used a tool
    expect(response.toolUses.length).toBeGreaterThan(0);

    // Wait for completion
    await session.waitForTurnComplete({ timeout: 30_000 });

    // Verify the file was updated
    const content = await readTestFile(testDir, 'counter.txt');
    expect(content).not.toBeNull();
    expect(content).toContain('count: 1');
  });
});
