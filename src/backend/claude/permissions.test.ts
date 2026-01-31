import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoApproveHandler,
  AutoDenyHandler,
  createAllowResponse,
  createDenyResponse,
  createPreToolUseHookResponse,
  createStopHookResponse,
  DeferredHandler,
  EDIT_TOOLS,
  ModeBasedHandler,
  READ_ONLY_TOOLS,
  shouldAutoApprove,
} from './permissions';
import type { CanUseToolRequest, HookCallbackRequest, PermissionMode } from './types';

// =============================================================================
// Sample Test Data
// =============================================================================

const canUseToolRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'Read',
  input: { file_path: '/test.txt' },
  tool_use_id: 'tool-123',
};

const bashToolRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'Bash',
  input: { command: 'npm test' },
  tool_use_id: 'tool-456',
};

const writeToolRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'Write',
  input: { file_path: '/test.txt', content: 'hello' },
  tool_use_id: 'tool-789',
};

const exitPlanModeRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'ExitPlanMode',
  input: {},
  tool_use_id: 'tool-exit',
};

const hookCallbackRequest: HookCallbackRequest = {
  subtype: 'hook_callback',
  callback_id: 'callback-123',
  tool_use_id: 'tool-456',
  input: {
    session_id: 'session-123',
    transcript_path: '/path/to/transcript',
    cwd: '/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/test.txt' },
  },
};

const stopHookRequest: HookCallbackRequest = {
  subtype: 'hook_callback',
  callback_id: 'stop-123',
  input: {
    session_id: 'session-123',
    transcript_path: '/path/to/transcript',
    cwd: '/project',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: true,
  },
};

const hookWithoutToolName: HookCallbackRequest = {
  subtype: 'hook_callback',
  callback_id: 'callback-no-tool',
  input: {
    session_id: 'session-123',
    transcript_path: '/path/to/transcript',
    cwd: '/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
  },
};

// =============================================================================
// Tool Constants Tests
// =============================================================================

describe('Tool Constants', () => {
  describe('READ_ONLY_TOOLS', () => {
    it('should contain Glob', () => {
      expect(READ_ONLY_TOOLS.has('Glob')).toBe(true);
    });

    it('should contain Grep', () => {
      expect(READ_ONLY_TOOLS.has('Grep')).toBe(true);
    });

    it('should contain Read', () => {
      expect(READ_ONLY_TOOLS.has('Read')).toBe(true);
    });

    it('should contain NotebookRead', () => {
      expect(READ_ONLY_TOOLS.has('NotebookRead')).toBe(true);
    });

    it('should contain Task', () => {
      expect(READ_ONLY_TOOLS.has('Task')).toBe(true);
    });

    it('should contain TodoWrite', () => {
      expect(READ_ONLY_TOOLS.has('TodoWrite')).toBe(true);
    });

    it('should contain TodoRead', () => {
      expect(READ_ONLY_TOOLS.has('TodoRead')).toBe(true);
    });

    it('should not contain Write', () => {
      expect(READ_ONLY_TOOLS.has('Write')).toBe(false);
    });

    it('should not contain Bash', () => {
      expect(READ_ONLY_TOOLS.has('Bash')).toBe(false);
    });

    it('should have exactly 7 tools', () => {
      expect(READ_ONLY_TOOLS.size).toBe(7);
    });
  });

  describe('EDIT_TOOLS', () => {
    it('should contain Write', () => {
      expect(EDIT_TOOLS.has('Write')).toBe(true);
    });

    it('should contain Edit', () => {
      expect(EDIT_TOOLS.has('Edit')).toBe(true);
    });

    it('should contain MultiEdit', () => {
      expect(EDIT_TOOLS.has('MultiEdit')).toBe(true);
    });

    it('should contain UndoEdit', () => {
      expect(EDIT_TOOLS.has('UndoEdit')).toBe(true);
    });

    it('should contain NotebookEdit', () => {
      expect(EDIT_TOOLS.has('NotebookEdit')).toBe(true);
    });

    it('should not contain Bash', () => {
      expect(EDIT_TOOLS.has('Bash')).toBe(false);
    });

    it('should not contain Read', () => {
      expect(EDIT_TOOLS.has('Read')).toBe(false);
    });

    it('should have exactly 5 tools', () => {
      expect(EDIT_TOOLS.size).toBe(5);
    });
  });
});

// =============================================================================
// shouldAutoApprove Function Tests
// =============================================================================

describe('shouldAutoApprove', () => {
  describe('bypassPermissions mode', () => {
    const mode: PermissionMode = 'bypassPermissions';

    it('should auto-approve Bash', () => {
      expect(shouldAutoApprove(mode, 'Bash')).toBe(true);
    });

    it('should auto-approve Write', () => {
      expect(shouldAutoApprove(mode, 'Write')).toBe(true);
    });

    it('should auto-approve Read', () => {
      expect(shouldAutoApprove(mode, 'Read')).toBe(true);
    });

    it('should NOT auto-approve ExitPlanMode (interactive tool)', () => {
      expect(shouldAutoApprove(mode, 'ExitPlanMode')).toBe(false);
    });

    it('should NOT auto-approve AskUserQuestion (interactive tool)', () => {
      expect(shouldAutoApprove(mode, 'AskUserQuestion')).toBe(false);
    });

    it('should auto-approve any arbitrary tool', () => {
      expect(shouldAutoApprove(mode, 'SomeRandomTool')).toBe(true);
    });
  });

  describe('plan mode', () => {
    const mode: PermissionMode = 'plan';

    it('should auto-approve Bash', () => {
      expect(shouldAutoApprove(mode, 'Bash')).toBe(true);
    });

    it('should auto-approve Write', () => {
      expect(shouldAutoApprove(mode, 'Write')).toBe(true);
    });

    it('should auto-approve Read', () => {
      expect(shouldAutoApprove(mode, 'Read')).toBe(true);
    });

    it('should not auto-approve ExitPlanMode', () => {
      expect(shouldAutoApprove(mode, 'ExitPlanMode')).toBe(false);
    });

    it('should auto-approve any other tool except ExitPlanMode', () => {
      expect(shouldAutoApprove(mode, 'SomeRandomTool')).toBe(true);
    });
  });

  describe('acceptEdits mode', () => {
    const mode: PermissionMode = 'acceptEdits';

    it('should auto-approve Read (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Read')).toBe(true);
    });

    it('should auto-approve Glob (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Glob')).toBe(true);
    });

    it('should auto-approve Write (edit tool)', () => {
      expect(shouldAutoApprove(mode, 'Write')).toBe(true);
    });

    it('should auto-approve Edit (edit tool)', () => {
      expect(shouldAutoApprove(mode, 'Edit')).toBe(true);
    });

    it('should not auto-approve Bash', () => {
      expect(shouldAutoApprove(mode, 'Bash')).toBe(false);
    });

    it('should not auto-approve unknown tools', () => {
      expect(shouldAutoApprove(mode, 'SomeRandomTool')).toBe(false);
    });
  });

  describe('default mode', () => {
    const mode: PermissionMode = 'default';

    it('should auto-approve Read (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Read')).toBe(true);
    });

    it('should auto-approve Glob (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Glob')).toBe(true);
    });

    it('should auto-approve Grep (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Grep')).toBe(true);
    });

    it('should auto-approve Task (read-only)', () => {
      expect(shouldAutoApprove(mode, 'Task')).toBe(true);
    });

    it('should not auto-approve Write', () => {
      expect(shouldAutoApprove(mode, 'Write')).toBe(false);
    });

    it('should not auto-approve Edit', () => {
      expect(shouldAutoApprove(mode, 'Edit')).toBe(false);
    });

    it('should not auto-approve Bash', () => {
      expect(shouldAutoApprove(mode, 'Bash')).toBe(false);
    });

    it('should not auto-approve unknown tools', () => {
      expect(shouldAutoApprove(mode, 'SomeRandomTool')).toBe(false);
    });
  });
});

// =============================================================================
// Helper Function Tests
// =============================================================================

describe('Helper Functions', () => {
  describe('createAllowResponse', () => {
    it('should return correct structure with empty updatedInput when not provided', () => {
      const response = createAllowResponse();
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should return correct structure with updatedInput', () => {
      const updatedInput = { file_path: '/updated.txt' };
      const response = createAllowResponse(updatedInput);
      expect(response).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/updated.txt' },
      });
    });

    it('should use empty object when undefined is passed', () => {
      const response = createAllowResponse(undefined);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
      expect('updatedInput' in response).toBe(true);
    });
  });

  describe('createDenyResponse', () => {
    it('should return correct structure with message only', () => {
      const response = createDenyResponse('Permission denied');
      expect(response).toEqual({
        behavior: 'deny',
        message: 'Permission denied',
      });
    });

    it('should return correct structure with interrupt true', () => {
      const response = createDenyResponse('Permission denied', true);
      expect(response).toEqual({
        behavior: 'deny',
        message: 'Permission denied',
        interrupt: true,
      });
    });

    it('should return correct structure with interrupt false', () => {
      const response = createDenyResponse('Permission denied', false);
      expect(response).toEqual({
        behavior: 'deny',
        message: 'Permission denied',
        interrupt: false,
      });
    });

    it('should not include interrupt key when undefined', () => {
      const response = createDenyResponse('Permission denied');
      expect('interrupt' in response).toBe(false);
    });
  });

  describe('createPreToolUseHookResponse', () => {
    it('should return correct structure for allow decision', () => {
      const response = createPreToolUseHookResponse('allow');
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    it('should return correct structure for deny decision', () => {
      const response = createPreToolUseHookResponse('deny');
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
    });

    it('should return correct structure for ask decision', () => {
      const response = createPreToolUseHookResponse('ask');
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
        },
      });
    });

    it('should include reason when provided', () => {
      const response = createPreToolUseHookResponse('deny', 'Not allowed');
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Not allowed',
        },
      });
    });

    it('should not include reason key when undefined', () => {
      const response = createPreToolUseHookResponse('allow');
      expect('permissionDecisionReason' in response.hookSpecificOutput).toBe(false);
    });
  });

  describe('createStopHookResponse', () => {
    it('should return correct structure for approve decision', () => {
      const response = createStopHookResponse('approve');
      expect(response).toEqual({ decision: 'approve' });
    });

    it('should return correct structure for block decision', () => {
      const response = createStopHookResponse('block');
      expect(response).toEqual({ decision: 'block' });
    });

    it('should include reason when provided', () => {
      const response = createStopHookResponse('block', 'User blocked');
      expect(response).toEqual({
        decision: 'block',
        reason: 'User blocked',
      });
    });

    it('should not include reason key when undefined', () => {
      const response = createStopHookResponse('approve');
      expect('reason' in response).toBe(false);
    });
  });
});

// =============================================================================
// AutoApproveHandler Tests
// =============================================================================

describe('AutoApproveHandler', () => {
  const handler = new AutoApproveHandler();

  describe('onCanUseTool', () => {
    it('should approve all tool requests', async () => {
      const response = await handler.onCanUseTool(canUseToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should approve Bash tool requests', async () => {
      const response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should approve Write tool requests', async () => {
      const response = await handler.onCanUseTool(writeToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });
  });

  describe('onPreToolUseHook', () => {
    it('should allow all PreToolUse hooks', async () => {
      const response = await handler.onPreToolUseHook(hookCallbackRequest);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });
  });

  describe('onStopHook', () => {
    it('should approve all Stop hooks', async () => {
      const response = await handler.onStopHook(stopHookRequest);
      expect(response).toEqual({ decision: 'approve' });
    });
  });
});

// =============================================================================
// AutoDenyHandler Tests
// =============================================================================

describe('AutoDenyHandler', () => {
  describe('with default message', () => {
    const handler = new AutoDenyHandler();

    it('should deny tool requests with default message', async () => {
      const response = await handler.onCanUseTool(canUseToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: 'Tool execution not allowed',
      });
    });

    it('should deny PreToolUse hooks with default message', async () => {
      const response = await handler.onPreToolUseHook(hookCallbackRequest);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tool execution not allowed',
        },
      });
    });

    it('should block Stop hooks with default message', async () => {
      const response = await handler.onStopHook(stopHookRequest);
      expect(response).toEqual({
        decision: 'block',
        reason: 'Tool execution not allowed',
      });
    });
  });

  describe('with custom message', () => {
    const customMessage = 'Read-only mode active';
    const handler = new AutoDenyHandler(customMessage);

    it('should deny tool requests with custom message', async () => {
      const response = await handler.onCanUseTool(canUseToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: customMessage,
      });
    });

    it('should deny PreToolUse hooks with custom message', async () => {
      const response = await handler.onPreToolUseHook(hookCallbackRequest);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: customMessage,
        },
      });
    });

    it('should block Stop hooks with custom message', async () => {
      const response = await handler.onStopHook(stopHookRequest);
      expect(response).toEqual({
        decision: 'block',
        reason: customMessage,
      });
    });
  });
});

// =============================================================================
// ModeBasedHandler Tests
// =============================================================================

describe('ModeBasedHandler', () => {
  describe('default mode without onAsk', () => {
    const handler = new ModeBasedHandler('default');

    it('should auto-approve read-only tools', async () => {
      const response = await handler.onCanUseTool(canUseToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should deny non-read-only tools with message', async () => {
      const response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'Bash' requires manual approval",
      });
    });

    it('should deny Write tool', async () => {
      const response = await handler.onCanUseTool(writeToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'Write' requires manual approval",
      });
    });
  });

  describe('default mode with onAsk callback', () => {
    it('should call onAsk for non-auto-approved tools', async () => {
      const onAsk = vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: {} });
      const handler = new ModeBasedHandler('default', onAsk);

      const response = await handler.onCanUseTool(bashToolRequest);
      expect(onAsk).toHaveBeenCalledWith(bashToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should not call onAsk for auto-approved tools', async () => {
      const onAsk = vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: {} });
      const handler = new ModeBasedHandler('default', onAsk);

      await handler.onCanUseTool(canUseToolRequest);
      expect(onAsk).not.toHaveBeenCalled();
    });
  });

  describe('acceptEdits mode', () => {
    const handler = new ModeBasedHandler('acceptEdits');

    it('should auto-approve read-only tools', async () => {
      const response = await handler.onCanUseTool(canUseToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should auto-approve Write tool', async () => {
      const response = await handler.onCanUseTool(writeToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should deny Bash tool', async () => {
      const response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'Bash' requires manual approval",
      });
    });
  });

  describe('plan mode', () => {
    const handler = new ModeBasedHandler('plan');

    it('should auto-approve all tools except ExitPlanMode', async () => {
      const response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should deny ExitPlanMode', async () => {
      const response = await handler.onCanUseTool(exitPlanModeRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'ExitPlanMode' requires manual approval",
      });
    });
  });

  describe('bypassPermissions mode', () => {
    const handler = new ModeBasedHandler('bypassPermissions');

    it('should auto-approve all tools', async () => {
      const response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should NOT auto-approve ExitPlanMode (interactive tool)', async () => {
      const response = await handler.onCanUseTool(exitPlanModeRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'ExitPlanMode' requires manual approval",
      });
    });
  });

  describe('onPreToolUseHook', () => {
    const handler = new ModeBasedHandler('default');

    it('should allow hooks for read-only tools', async () => {
      const readHook: HookCallbackRequest = {
        ...hookCallbackRequest,
        input: { ...hookCallbackRequest.input, tool_name: 'Read' },
      };
      const response = await handler.onPreToolUseHook(readHook);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    it('should ask for hooks for non-read-only tools', async () => {
      const response = await handler.onPreToolUseHook(hookCallbackRequest);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: "Tool 'Write' requires approval",
        },
      });
    });

    it('should ask when no tool name provided', async () => {
      const response = await handler.onPreToolUseHook(hookWithoutToolName);
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'No tool name provided',
        },
      });
    });
  });

  describe('onStopHook', () => {
    const handler = new ModeBasedHandler('default');

    it('should always approve Stop hooks', async () => {
      const response = await handler.onStopHook(stopHookRequest);
      expect(response).toEqual({ decision: 'approve' });
    });
  });

  describe('setMode and getMode', () => {
    it('should update the mode', () => {
      const handler = new ModeBasedHandler('default');
      expect(handler.getMode()).toBe('default');

      handler.setMode('bypassPermissions');
      expect(handler.getMode()).toBe('bypassPermissions');
    });

    it('should change behavior after setMode', async () => {
      const handler = new ModeBasedHandler('default');

      // Initially deny Bash
      let response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({
        behavior: 'deny',
        message: "Tool 'Bash' requires manual approval",
      });

      // After changing mode, allow Bash
      handler.setMode('bypassPermissions');
      response = await handler.onCanUseTool(bashToolRequest);
      expect(response).toEqual({ behavior: 'allow', updatedInput: {} });
    });
  });
});

// =============================================================================
// DeferredHandler Tests
// =============================================================================

describe('DeferredHandler', () => {
  let handler: DeferredHandler;

  beforeEach(() => {
    handler = new DeferredHandler({ timeout: 5000 });
  });

  afterEach(() => {
    handler.cancelAll();
  });

  describe('event emission', () => {
    it('should emit permission_request event for can_use_tool', async () => {
      const eventHandler = vi.fn();
      handler.on('permission_request', eventHandler);

      const promise = handler.onCanUseTool(canUseToolRequest);

      // Allow event to be emitted
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventHandler).toHaveBeenCalledWith(canUseToolRequest, 'tool-123');

      // Clean up by approving
      handler.approve('tool-123');
      await promise;
    });

    it('should emit hook_request event for PreToolUse hooks', async () => {
      const eventHandler = vi.fn();
      handler.on('hook_request', eventHandler);

      const promise = handler.onPreToolUseHook(hookCallbackRequest);

      // Allow event to be emitted
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventHandler).toHaveBeenCalledWith(hookCallbackRequest, 'callback-123');

      // Clean up
      handler.approve('callback-123');
      await promise;
    });

    it('should emit stop_request event for Stop hooks', async () => {
      const eventHandler = vi.fn();
      handler.on('stop_request', eventHandler);

      const promise = handler.onStopHook(stopHookRequest);

      // Allow event to be emitted
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventHandler).toHaveBeenCalledWith(stopHookRequest, 'stop-123');

      // Clean up
      handler.approve('stop-123');
      await promise;
    });
  });

  describe('approve', () => {
    it('should resolve pending permission request with original tool input', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      // Allow event to be emitted
      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.approve('tool-123');
      const response = await promise;
      // When no updatedInput is provided, it should use the original tool input
      expect(response).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/test.txt' },
      });
    });

    it('should resolve pending permission request with updated input', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.approve('tool-123', { file_path: '/updated.txt' });
      const response = await promise;
      expect(response).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/updated.txt' },
      });
    });

    it('should resolve PreToolUse hook with allow response', async () => {
      const promise = handler.onPreToolUseHook(hookCallbackRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.approve('callback-123');
      const response = await promise;
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    it('should resolve Stop hook with approve response', async () => {
      const promise = handler.onStopHook(stopHookRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.approve('stop-123');
      const response = await promise;
      expect(response).toEqual({ decision: 'approve' });
    });

    it('should throw error for unknown request ID', () => {
      expect(() => handler.approve('unknown-id')).toThrow(
        'No pending request found with ID: unknown-id'
      );
    });
  });

  describe('deny', () => {
    it('should resolve pending permission request with deny response', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.deny('tool-123', 'User rejected');
      const response = await promise;
      expect(response).toEqual({
        behavior: 'deny',
        message: 'User rejected',
      });
    });

    it('should resolve PreToolUse hook with deny response', async () => {
      const promise = handler.onPreToolUseHook(hookCallbackRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.deny('callback-123', 'User rejected');
      const response = await promise;
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'User rejected',
        },
      });
    });

    it('should resolve Stop hook with block response', async () => {
      const promise = handler.onStopHook(stopHookRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.deny('stop-123', 'User blocked');
      const response = await promise;
      expect(response).toEqual({
        decision: 'block',
        reason: 'User blocked',
      });
    });

    it('should throw error for unknown request ID', () => {
      expect(() => handler.deny('unknown-id', 'denied')).toThrow(
        'No pending request found with ID: unknown-id'
      );
    });
  });

  describe('cancel', () => {
    it('should reject pending request with error', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.cancel('tool-123', 'Cancelled by user');

      await expect(promise).rejects.toThrow('Cancelled by user');
    });

    it('should reject with default message when no reason provided', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.cancel('tool-123');

      await expect(promise).rejects.toThrow('Request cancelled');
    });

    it('should not throw for unknown request ID', () => {
      // Should be a no-op
      expect(() => handler.cancel('unknown-id')).not.toThrow();
    });
  });

  describe('cancelAll', () => {
    it('should cancel all pending requests', async () => {
      const promise1 = handler.onCanUseTool(canUseToolRequest);
      const promise2 = handler.onPreToolUseHook(hookCallbackRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.cancelAll('Session ended');

      await expect(promise1).rejects.toThrow('Session ended');
      await expect(promise2).rejects.toThrow('Session ended');
    });

    it('should use default message when no reason provided', async () => {
      const promise = handler.onCanUseTool(canUseToolRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      handler.cancelAll();

      await expect(promise).rejects.toThrow('All requests cancelled');
    });

    it('should clear pending count', async () => {
      const promise1 = handler.onCanUseTool(canUseToolRequest);
      const promise2 = handler.onPreToolUseHook(hookCallbackRequest);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler.getPendingCount()).toBe(2);

      handler.cancelAll();

      expect(handler.getPendingCount()).toBe(0);

      // Properly catch the rejections
      await expect(promise1).rejects.toThrow('All requests cancelled');
      await expect(promise2).rejects.toThrow('All requests cancelled');
    });
  });

  describe('timeout behavior', () => {
    it('should reject request after timeout', async () => {
      const shortTimeoutHandler = new DeferredHandler({ timeout: 50 });

      const promise = shortTimeoutHandler.onCanUseTool(canUseToolRequest);

      await expect(promise).rejects.toThrow('Permission request timed out after 50ms');
    });

    it('should not timeout with timeout=0', async () => {
      const noTimeoutHandler = new DeferredHandler({ timeout: 0 });

      const promise = noTimeoutHandler.onCanUseTool(canUseToolRequest);

      // Wait a bit and verify it hasn't rejected
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(noTimeoutHandler.hasPendingRequest('tool-123')).toBe(true);

      // Clean up
      noTimeoutHandler.approve('tool-123');
      await promise;
    });
  });

  describe('utility methods', () => {
    it('should track pending count correctly', async () => {
      expect(handler.getPendingCount()).toBe(0);

      const promise1 = handler.onCanUseTool(canUseToolRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handler.getPendingCount()).toBe(1);

      const promise2 = handler.onPreToolUseHook(hookCallbackRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handler.getPendingCount()).toBe(2);

      handler.approve('tool-123');
      await promise1;
      expect(handler.getPendingCount()).toBe(1);

      handler.cancel('callback-123');
      await expect(promise2).rejects.toThrow('Request cancelled');
      expect(handler.getPendingCount()).toBe(0);
    });

    it('should correctly identify pending requests', async () => {
      expect(handler.hasPendingRequest('tool-123')).toBe(false);

      const promise = handler.onCanUseTool(canUseToolRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler.hasPendingRequest('tool-123')).toBe(true);
      expect(handler.hasPendingRequest('unknown-id')).toBe(false);

      handler.approve('tool-123');
      await promise;
      expect(handler.hasPendingRequest('tool-123')).toBe(false);
    });
  });

  describe('generated request IDs', () => {
    it('should generate unique request ID when tool_use_id is not provided', async () => {
      const requestWithoutId: CanUseToolRequest = {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: '/test.txt' },
      };

      const eventHandler = vi.fn();
      handler.on('permission_request', eventHandler);

      handler.onCanUseTool(requestWithoutId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventHandler).toHaveBeenCalled();
      const emittedId = eventHandler.mock.calls[0][1];
      expect(emittedId).toMatch(/^deferred-\d+-\d+$/);

      // Clean up
      handler.approve(emittedId);
    });

    it('should use callback_id when provided (even empty string)', async () => {
      // Note: The implementation uses callback_id ?? generateRequestId(),
      // so empty string is used as-is (it's not nullish)
      const hookWithEmptyId: HookCallbackRequest = {
        subtype: 'hook_callback',
        callback_id: '', // Empty callback_id - will be used as-is
        input: {
          session_id: 'session-123',
          transcript_path: '/path/to/transcript',
          cwd: '/project',
          permission_mode: 'default',
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
        },
      };

      const eventHandler = vi.fn();
      handler.on('hook_request', eventHandler);

      handler.onPreToolUseHook(hookWithEmptyId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventHandler).toHaveBeenCalled();
      // Empty string is used as the ID since ?? only triggers for null/undefined
      const emittedId = eventHandler.mock.calls[0][1];
      expect(emittedId).toBe('');

      // Clean up - need to use empty string to approve
      handler.approve('');
    });
  });
});
