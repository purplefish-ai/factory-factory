import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENTS_LIST_METHOD, SUBAGENTS_READ_METHOD } from '@/shared/acp-protocol/subagents';
import {
  type AcpRuntimeManager,
  createManagerTestHarness,
  mockExtMethod,
  mockInitialize,
  mockLoadSession,
  mockNewSession,
  mockSpawn,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  codexOptions,
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
  subagentBrowseCapabilities,
} from './acp-runtime-manager.test-helpers';

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    ({ manager } = createManagerTestHarness());
  });

  describe('sub-agent browsing extensions', () => {
    it('classifies a browse-only client before provider restoration completes', async () => {
      const child = setupSuccessfulSpawn({ ...subagentBrowseCapabilities(), loadSession: true });
      const initialization = createDeferred<{
        protocolVersion: number;
        agentCapabilities: Record<string, unknown>;
        agentInfo: { name: string };
      }>();
      mockInitialize.mockReturnValueOnce(initialization.promise);
      const creation = manager.getOrCreateClient(
        'db-session-1',
        {
          ...codexOptions(),
          purpose: 'browse',
          resumeProviderSessionId: 'provider-session-existing',
        },
        defaultHandlers(),
        defaultContext()
      );
      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });
      expect(manager.isBrowseOnlySession('db-session-1')).toBe(true);
      initialization.resolve({
        protocolVersion: 1,
        agentCapabilities: { ...subagentBrowseCapabilities(), loadSession: true },
        agentInfo: { name: 'codex-app-server-acp' },
      });
      await creation;
      expect(manager.isBrowseOnlySession('db-session-1')).toBe(true);
      exitChildAfterSigterm(child);
      await manager.stopClient('db-session-1');
    });
    it('emits active runtime error purpose after promoting a browse runtime', async () => {
      const child = setupSuccessfulSpawn({ ...subagentBrowseCapabilities(), loadSession: true });
      mockExtMethod.mockResolvedValueOnce({ subagents: [], nextCursor: null });
      const onRuntimeError = vi.fn();
      const browseHandle = await manager.getOrCreateClient(
        'db-session-1',
        {
          ...codexOptions(),
          purpose: 'browse',
          resumeProviderSessionId: 'provider-session-existing',
        },
        { ...defaultHandlers(), onRuntimeError },
        defaultContext()
      );
      await expect(
        manager.listSubagents('db-session-1', { cursor: null, limit: 50 })
      ).resolves.toEqual({ subagents: [], nextCursor: null });
      expect(manager.getClient('db-session-1')).toBeUndefined();
      expect(manager.isSessionRunning('db-session-1')).toBe(false);
      const activeHandle = await manager.getOrCreateClient(
        'db-session-1',
        { ...codexOptions(), purpose: 'active' },
        defaultHandlers(),
        defaultContext()
      );
      expect(activeHandle).toBe(browseHandle);
      expect(manager.getClient('db-session-1')).toBe(browseHandle);
      expect(manager.isSessionRunning('db-session-1')).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      child.emit('error', new Error('provider transport failed'));
      expect(onRuntimeError).toHaveBeenCalledWith({
        sessionId: 'db-session-1',
        error: expect.objectContaining({ message: 'provider transport failed' }),
        incarnationId: expect.any(String),
        purpose: 'active',
      });
    });
    it('requires every live runtime and fence source to be browse-only', async () => {
      // Catches treating any browse source as sufficient while active work is live.
      for (const [runtimePurpose, fencePurpose, expected] of [
        ['active', 'browse', false],
        ['browse', 'active', false],
        ['browse', 'browse', true],
      ] as const) {
        const sessionId = `${runtimePurpose}-${fencePurpose}`;
        setupSuccessfulSpawn(runtimePurpose === 'browse' ? { loadSession: true } : undefined);
        await manager.getOrCreateClient(
          sessionId,
          {
            ...defaultOptions(),
            purpose: runtimePurpose,
            ...(runtimePurpose === 'browse'
              ? { resumeProviderSessionId: 'provider-session-existing' }
              : {}),
          },
          defaultHandlers(),
          defaultContext()
        );
        const fence = createDeferred<void>();
        const operation = manager.runClientCreationOperation(
          sessionId,
          fencePurpose,
          () => fence.promise
        );
        expect(manager.isBrowseOnlySession(sessionId)).toBe(expected);
        fence.resolve(undefined);
        await operation;
      }
    });
    it('does not replace a missing browse-only provider session with a new session', async () => {
      const child = setupSuccessfulSpawn({ ...subagentBrowseCapabilities(), loadSession: true });
      exitChildAfterSigterm(child);
      mockLoadSession.mockRejectedValueOnce(new Error('stored provider session missing'));
      await expect(
        manager.getOrCreateClient(
          'db-session-1',
          {
            ...codexOptions(),
            purpose: 'browse',
            resumeProviderSessionId: 'provider-session-missing',
          },
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toMatchObject({
        name: 'AcpBrowseSessionUnavailableError',
        cause: { message: 'stored provider session missing' },
      });
      expect(mockNewSession).not.toHaveBeenCalled();
    });
    it('runtime exit event fences replacement creation until current exit handling settles', async () => {
      const firstChild = setupSuccessfulSpawn();
      const exitHandling = createDeferred<void>();
      const firstHandlers = {
        ...defaultHandlers(),
        onRuntimeExit: vi.fn(() => exitHandling.promise),
      };
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        firstHandlers,
        defaultContext()
      );
      firstChild.exitCode = 1;
      firstChild.emit('exit', 1, null);
      firstChild.emit('exit', 1, null);
      await vi.waitFor(() => {
        expect(firstHandlers.onRuntimeExit).toHaveBeenCalledOnce();
      });
      expect(firstHandlers.onRuntimeExit).toHaveBeenCalledWith({
        sessionId: 'db-session-1',
        exitCode: 1,
        incarnationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        purpose: 'active',
        managed: false,
      });
      const replacementChild = setupSuccessfulSpawn();
      const replacementPromise = manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      let replacementSettled = false;
      void replacementPromise.then(() => {
        replacementSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replacementSettled).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(manager.getBrowseClient('db-session-1')).toBeUndefined();
      exitHandling.resolve();
      const replacementHandle = await replacementPromise;

      expect(manager.getBrowseClient('db-session-1')).toBe(replacementHandle);
      expect(manager.isBrowseOnlySession('db-session-1')).toBe(false);
      expect(manager.getClient('db-session-1')).toBe(replacementHandle);
      exitChildAfterSigterm(replacementChild);
      await manager.stopClient('db-session-1');
    });
    it('classifies a provider without loadSession as unsupported for browse restoration', async () => {
      const child = setupSuccessfulSpawn(subagentBrowseCapabilities());
      exitChildAfterSigterm(child);
      await expect(
        manager.getOrCreateClient(
          'db-session-1',
          {
            ...codexOptions(),
            purpose: 'browse',
            resumeProviderSessionId: 'provider-session-existing',
          },
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toMatchObject({ name: 'AcpBrowseSessionUnavailableError' });
      expect(mockNewSession).not.toHaveBeenCalled();
    });
    it('returns the negotiated capability only for a live handle', async () => {
      expect(manager.getSubagentBrowseCapability('session-1')).toBeNull();
      const child = setupSuccessfulSpawn(subagentBrowseCapabilities());
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      expect(manager.getSubagentBrowseCapability('session-1')).toEqual({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      child.killed = true;
      expect(manager.getSubagentBrowseCapability('session-1')).toBeNull();
    });
    it('lists sub-agents with the provider session ID and unchanged cursor', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      mockExtMethod.mockResolvedValueOnce({ subagents: [], nextCursor: null });
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      const result = await manager.listSubagents('db-session-1', {
        cursor: 'list-cursor-7',
        limit: 50,
      });
      expect(result).toEqual({ subagents: [], nextCursor: null });
      expect(mockExtMethod).toHaveBeenCalledWith(SUBAGENTS_LIST_METHOD, {
        sessionId: 'provider-session-123',
        cursor: 'list-cursor-7',
        limit: 50,
      });
    });

    it('reads a transcript with the provider session ID and unchanged cursor', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      mockExtMethod.mockResolvedValueOnce({
        projectionBoundary: 'turn',
        updates: [],
        nextCursor: 'read-cursor-9',
      });
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      const result = await manager.readSubagentTranscript('db-session-1', {
        subagentId: 'child-1',
        cursor: 'read-cursor-8',
        limit: 10,
      });
      expect(result).toEqual({
        projectionBoundary: 'turn',
        updates: [],
        nextCursor: 'read-cursor-9',
      });
      expect(mockExtMethod).toHaveBeenCalledWith(SUBAGENTS_READ_METHOD, {
        sessionId: 'provider-session-123',
        subagentId: 'child-1',
        cursor: 'read-cursor-8',
        limit: 10,
      });
    });

    it('rejects malformed extension inputs before calling the provider', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(
        manager.listSubagents('db-session-1', { cursor: null, limit: 101 })
      ).rejects.toThrow();
      expect(mockExtMethod).not.toHaveBeenCalled();
    });

    it('normalizes malformed list and transcript responses as provider precondition errors', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      mockExtMethod.mockResolvedValueOnce({ subagents: 'invalid', nextCursor: null });
      await expect(
        manager.listSubagents('db-session-1', { cursor: null, limit: 50 })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
        message: 'Sub-agent list is unavailable because the provider returned an invalid response.',
      });

      mockExtMethod.mockResolvedValueOnce({
        projectionBoundary: 'turn',
        updates: [{ sessionUpdate: 'unknown' }],
        nextCursor: null,
      });
      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
        message:
          'Sub-agent transcript is unavailable because the provider returned an invalid response.',
      });
    });

    it('normalizes provider extension errors into safe application errors', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      mockExtMethod.mockRejectedValueOnce({
        code: -32_602,
        message: 'Invalid params: secret provider detail',
        data: { cursor: 'invalid' },
      });
      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'child-1',
          cursor: 'invalid',
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'INVALID_INPUT',
        message: 'Invalid sub-agent transcript request.',
      });

      mockExtMethod.mockRejectedValueOnce({
        code: -32_002,
        message: 'Resource not found: secret provider thread',
      });
      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'foreign-child',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'NOT_FOUND',
        message: 'Sub-agent transcript not found for this session.',
      });

      mockExtMethod.mockRejectedValueOnce({
        code: -32_603,
        message: 'Internal error: mismatched provider thread IDs',
      });
      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
        message:
          'Sub-agent transcript is unavailable because the provider returned an invalid response.',
      });
    });

    it('preserves JSON-RPC codes carried by Error subclasses', async () => {
      setupSuccessfulSpawn(subagentBrowseCapabilities());
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      const providerError = Object.assign(new Error('Resource not found: provider thread'), {
        code: -32_002,
        data: { threadId: 'missing-child' },
      });
      mockExtMethod.mockRejectedValueOnce(providerError);

      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'missing-child',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'NOT_FOUND',
        message: 'Sub-agent transcript not found for this session.',
      });
    });

    it('rejects extension requests without a live handle or negotiated capability', async () => {
      await expect(
        manager.listSubagents('missing-session', { cursor: null, limit: 50 })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
        message: 'Sub-agent browsing requires a running parent session.',
      });

      setupSuccessfulSpawn();
      await manager.getOrCreateClient(
        'db-session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(
        manager.readSubagentTranscript('db-session-1', {
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        name: 'AcpSubagentBrowseError',
        code: 'PRECONDITION_FAILED',
        message: 'Sub-agent browsing is unavailable for this session.',
      });
      expect(mockExtMethod).not.toHaveBeenCalled();
    });
  });
});
