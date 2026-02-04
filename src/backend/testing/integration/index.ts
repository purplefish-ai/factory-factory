/**
 * Integration test utilities.
 *
 * @example
 * ```typescript
 * import { TestSession, createTempRepo, cleanupTempRepo } from '@/backend/testing/integration';
 *
 * const testDir = await createTempRepo({ files: { 'test.txt': 'hello' } });
 * const session = await TestSession.create({ workspacePath: testDir, model: 'haiku' });
 *
 * await session.send('Read test.txt');
 * const response = await session.waitForResponse();
 *
 * await session.cleanup();
 * await cleanupTempRepo(testDir);
 * ```
 */

export {
  cleanupTempRepo,
  createTempRepo,
  fileExists,
  readTestFile,
  type TempRepoOptions,
  waitFor,
} from './helpers';
export {
  type ReceivedMessage,
  TestSession,
  type TestSessionOptions,
  type ToolUseEvent,
  type WaitForToolOptions,
  type WaitOptions,
} from './test-session';
