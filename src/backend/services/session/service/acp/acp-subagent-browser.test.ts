import { describe, expect, it, vi } from 'vitest';
import { SUBAGENTS_LIST_METHOD, SUBAGENTS_READ_METHOD } from '@/shared/acp-protocol/subagents';
import { AcpSubagentBrowseError } from './acp-runtime-errors';
import {
  createTestProcessHandle,
  subagentBrowseCapabilities,
} from './acp-runtime-manager.test-helpers';
import { AcpSubagentBrowser } from './acp-subagent-browser';

describe('AcpSubagentBrowser', () => {
  it('uses the provider session ID when listing sub-agents', async () => {
    // Catches dropping the provider-session translation before calling the ACP extension.
    const browser = new AcpSubagentBrowser();
    const extMethod = vi.fn().mockResolvedValue({ subagents: [], nextCursor: null });
    const handle = createTestProcessHandle({
      providerSessionId: 'provider-session-1',
      agentCapabilities: subagentBrowseCapabilities(),
      connection: { extMethod },
    });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).resolves.toEqual({
      subagents: [],
      nextCursor: null,
    });
    expect(extMethod).toHaveBeenCalledWith(SUBAGENTS_LIST_METHOD, {
      sessionId: 'provider-session-1',
      cursor: null,
      limit: 20,
    });
  });

  it('returns the negotiated capability only from a supplied handle', () => {
    // Catches treating missing handles or malformed capability metadata as browse support.
    const browser = new AcpSubagentBrowser();
    expect(browser.getCapability(undefined)).toBeNull();
    expect(browser.getCapability(createTestProcessHandle())).toBeNull();
    expect(
      browser.getCapability(
        createTestProcessHandle({ agentCapabilities: subagentBrowseCapabilities() })
      )
    ).toEqual({ version: 1, list: true, read: true, notifications: true });
  });

  it('rejects a missing handle before inspecting browse capability', async () => {
    // Catches changing the precedence from unavailable runtime to unsupported capability.
    const browser = new AcpSubagentBrowser();

    await expect(
      browser.listSubagents(undefined, { cursor: null, limit: 20 })
    ).rejects.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: 'PRECONDITION_FAILED',
      message: 'Sub-agent browsing requires a running parent session.',
    });
  });

  it('rejects a handle without the negotiated browse capability', async () => {
    // Catches sending ACP extension methods to providers that did not opt into browsing.
    const browser = new AcpSubagentBrowser();
    const extMethod = vi.fn();
    const handle = createTestProcessHandle({ connection: { extMethod } });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).rejects.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: 'PRECONDITION_FAILED',
      message: 'Sub-agent browsing is unavailable for this session.',
    });
    expect(extMethod).not.toHaveBeenCalled();
  });

  it('rejects invalid list input without calling the provider', async () => {
    // Catches allowing invalid pagination values through to the ACP provider.
    const browser = new AcpSubagentBrowser();
    const extMethod = vi.fn();
    const handle = createTestProcessHandle({
      agentCapabilities: subagentBrowseCapabilities(),
      connection: { extMethod },
    });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 101 })).rejects.toMatchObject(
      {
        name: 'AcpSubagentBrowseError',
        code: 'INVALID_INPUT',
        message: 'Invalid sub-agent list request.',
      }
    );
    expect(extMethod).not.toHaveBeenCalled();
  });

  it('normalizes malformed list responses as protocol failures', async () => {
    // Catches returning an unvalidated provider response to callers.
    const browser = new AcpSubagentBrowser();
    const handle = createTestProcessHandle({
      agentCapabilities: subagentBrowseCapabilities(),
      connection: {
        extMethod: vi.fn().mockResolvedValue({ subagents: 'invalid', nextCursor: null }),
      },
    });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).rejects.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: 'PRECONDITION_FAILED',
      message: 'Sub-agent list is unavailable because the provider returned an invalid response.',
    });
  });

  it.each([
    [-32_602, 'INVALID_INPUT', 'Invalid sub-agent list request.'],
    [-32_002, 'NOT_FOUND', 'Sub-agent list not found for this session.'],
    [-32_601, 'PRECONDITION_FAILED', 'Sub-agent browsing is unavailable for this session.'],
    [-32_000, 'PRECONDITION_FAILED', 'Provider authentication is required for sub-agent browsing.'],
    [
      -32_603,
      'PRECONDITION_FAILED',
      'Sub-agent list is unavailable because the provider returned an invalid response.',
    ],
    [
      -32_600,
      'PRECONDITION_FAILED',
      'Sub-agent list is unavailable because the provider returned an invalid response.',
    ],
    [
      -32_700,
      'PRECONDITION_FAILED',
      'Sub-agent list is unavailable because the provider returned an invalid response.',
    ],
  ])('normalizes provider code %i into %s', async (code, expectedCode, message) => {
    // Catches leaking provider-specific JSON-RPC failures through the application boundary.
    const browser = new AcpSubagentBrowser();
    const handle = createTestProcessHandle({
      agentCapabilities: subagentBrowseCapabilities(),
      connection: {
        extMethod: vi.fn().mockRejectedValue({ code, message: 'provider-specific detail' }),
      },
    });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).rejects.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: expectedCode,
      message,
    });
  });

  it('normalizes unknown provider errors without exposing their message', async () => {
    // Catches surfacing arbitrary provider error detail to browse callers.
    const browser = new AcpSubagentBrowser();
    const handle = createTestProcessHandle({
      agentCapabilities: subagentBrowseCapabilities(),
      connection: { extMethod: vi.fn().mockRejectedValue(new Error('secret provider detail')) },
    });

    await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).rejects.toEqual(
      expect.objectContaining({
        name: 'AcpSubagentBrowseError',
        code: 'INTERNAL_ERROR',
        message: 'Sub-agent list request failed.',
      })
    );
  });

  it('returns validated transcript updates using the provider session ID', async () => {
    // Catches transcript calls using the database session or losing valid update payloads.
    const browser = new AcpSubagentBrowser();
    const extMethod = vi.fn().mockResolvedValue({
      projectionBoundary: 'turn',
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello', _meta: null },
        },
      ],
      nextCursor: 'read-cursor-2',
    });
    const handle = createTestProcessHandle({
      providerSessionId: 'provider-session-1',
      agentCapabilities: subagentBrowseCapabilities(),
      connection: { extMethod },
    });

    await expect(
      browser.readSubagentTranscript(handle, {
        subagentId: 'child-1',
        cursor: 'read-cursor-1',
        limit: 10,
      })
    ).resolves.toEqual({
      projectionBoundary: 'turn',
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello', _meta: null },
        },
      ],
      nextCursor: 'read-cursor-2',
    });
    expect(extMethod).toHaveBeenCalledWith(SUBAGENTS_READ_METHOD, {
      sessionId: 'provider-session-1',
      subagentId: 'child-1',
      cursor: 'read-cursor-1',
      limit: 10,
    });
  });

  it('preserves the shared browse-error identity for invalid transcript input', async () => {
    // Catches browser failures being recreated as generic Error instances.
    const browser = new AcpSubagentBrowser();
    const handle = createTestProcessHandle({ agentCapabilities: subagentBrowseCapabilities() });
    const error = await browser
      .readSubagentTranscript(handle, { subagentId: '', cursor: null, limit: 10 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AcpSubagentBrowseError);
  });
});
