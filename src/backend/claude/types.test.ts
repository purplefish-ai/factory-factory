import { describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  CanUseToolRequest,
  ClaudeContentItem,
  ClaudeJson,
  ClaudeStreamEvent,
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
  HookCallbackRequest,
  ResultMessage,
  StreamEventMessage,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from './types';
import {
  isAssistantMessage,
  isCanUseToolRequest,
  isContentBlockDeltaEvent,
  isContentBlockStartEvent,
  isContentBlockStopEvent,
  isControlCancelRequest,
  isControlRequest,
  isControlResponse,
  isHookCallbackRequest,
  isMessageDeltaEvent,
  isMessageStartEvent,
  isMessageStopEvent,
  isResultMessage,
  isStreamEventMessage,
  isSystemMessage,
  isTextContent,
  isThinkingContent,
  isToolResultContent,
  isToolUseContent,
  isUserMessage,
} from './types';

// =============================================================================
// Sample Test Data
// =============================================================================

const systemInitMessage: SystemMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'abc123',
  cwd: '/project',
  tools: [],
};

const systemStatusMessage: SystemMessage = {
  type: 'system',
  subtype: 'status',
  session_id: 'abc123',
  status: 'running',
};

const systemHookStartedMessage: SystemMessage = {
  type: 'system',
  subtype: 'hook_started',
  session_id: 'abc123',
  hook_id: 'hook-1',
  hook_name: 'pre-tool',
  hook_event: 'PreToolUse',
};

const assistantMessage: AssistantMessage = {
  type: 'assistant',
  session_id: 'abc123',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
  },
};

const userMessage: UserMessage = {
  type: 'user',
  session_id: 'abc123',
  message: {
    role: 'user',
    content: 'Hi there',
  },
};

const syntheticUserMessage: UserMessage = {
  type: 'user',
  session_id: 'abc123',
  isSynthetic: true,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'result' }],
  },
};

const streamEventMessage: StreamEventMessage = {
  type: 'stream_event',
  session_id: 'abc123',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hi' },
  },
};

const resultMessage: ResultMessage = {
  type: 'result',
  subtype: 'success',
  session_id: 'abc123',
  durationMs: 1500,
  numTurns: 3,
};

const errorResultMessage: ResultMessage = {
  type: 'result',
  subtype: 'error',
  session_id: 'abc123',
  isError: true,
  error: 'Something went wrong',
};

const controlRequest: ControlRequest = {
  type: 'control_request',
  request_id: 'req-123',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Read',
    input: { file_path: '/test.txt' },
    tool_use_id: 'tool-456',
  },
};

const hookCallbackControlRequest: ControlRequest = {
  type: 'control_request',
  request_id: 'req-456',
  request: {
    subtype: 'hook_callback',
    callback_id: 'callback-1',
    input: {
      session_id: 'abc123',
      transcript_path: '/transcripts/abc123.json',
      cwd: '/project',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    },
  },
};

const controlResponse: ControlResponse = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'req-123',
    response: {
      behavior: 'allow',
      updatedInput: {},
    },
  },
};

const controlCancelRequest: ControlCancelRequest = {
  type: 'control_cancel_request',
  request_id: 'req-123',
};

// Content items
const textContent: TextContent = {
  type: 'text',
  text: 'Hello world',
};

const thinkingContent: ThinkingContent = {
  type: 'thinking',
  thinking: 'Let me analyze this...',
};

const toolUseContent: ToolUseContent = {
  type: 'tool_use',
  id: 'tool-123',
  name: 'Read',
  input: { file_path: '/test.txt' },
};

const toolResultContent: ToolResultContent = {
  type: 'tool_result',
  tool_use_id: 'tool-123',
  content: 'File contents here',
};

const toolResultContentWithError: ToolResultContent = {
  type: 'tool_result',
  tool_use_id: 'tool-456',
  content: 'Error occurred',
  is_error: true,
};

// Control request types
const canUseToolRequest: CanUseToolRequest = {
  subtype: 'can_use_tool',
  tool_name: 'Bash',
  input: { command: 'npm test' },
  tool_use_id: 'tool-789',
};

const hookCallbackRequest: HookCallbackRequest = {
  subtype: 'hook_callback',
  callback_id: 'callback-1',
  input: {
    session_id: 'abc123',
    transcript_path: '/transcripts/abc123.json',
    cwd: '/project',
    permission_mode: 'default',
    hook_event_name: 'Stop',
  },
};

// Stream events
const messageStartEvent: ClaudeStreamEvent = {
  type: 'message_start',
  message: {
    role: 'assistant',
    content: [],
  },
};

const contentBlockStartEvent: ClaudeStreamEvent = {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
};

const contentBlockDeltaEvent: ClaudeStreamEvent = {
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: 'Hello' },
};

const thinkingDeltaEvent: ClaudeStreamEvent = {
  type: 'content_block_delta',
  index: 1,
  delta: { type: 'thinking_delta', thinking: 'Analyzing...' },
};

const contentBlockStopEvent: ClaudeStreamEvent = {
  type: 'content_block_stop',
  index: 0,
};

const messageDeltaEvent: ClaudeStreamEvent = {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 150 },
};

const messageStopEvent: ClaudeStreamEvent = {
  type: 'message_stop',
};

// =============================================================================
// Message Type Guard Tests
// =============================================================================

describe('Message Type Guards', () => {
  describe('isSystemMessage', () => {
    it('should return true for system init messages', () => {
      expect(isSystemMessage(systemInitMessage)).toBe(true);
    });

    it('should return true for system status messages', () => {
      expect(isSystemMessage(systemStatusMessage)).toBe(true);
    });

    it('should return true for system hook_started messages', () => {
      expect(isSystemMessage(systemHookStartedMessage)).toBe(true);
    });

    it('should return false for assistant messages', () => {
      expect(isSystemMessage(assistantMessage)).toBe(false);
    });

    it('should return false for user messages', () => {
      expect(isSystemMessage(userMessage)).toBe(false);
    });

    it('should return false for stream event messages', () => {
      expect(isSystemMessage(streamEventMessage)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isSystemMessage(resultMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isSystemMessage(controlRequest)).toBe(false);
    });
  });

  describe('isAssistantMessage', () => {
    it('should return true for assistant messages', () => {
      expect(isAssistantMessage(assistantMessage)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isAssistantMessage(systemInitMessage)).toBe(false);
    });

    it('should return false for user messages', () => {
      expect(isAssistantMessage(userMessage)).toBe(false);
    });

    it('should return false for stream event messages', () => {
      expect(isAssistantMessage(streamEventMessage)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isAssistantMessage(resultMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isAssistantMessage(controlRequest)).toBe(false);
    });
  });

  describe('isUserMessage', () => {
    it('should return true for user messages', () => {
      expect(isUserMessage(userMessage)).toBe(true);
    });

    it('should return true for synthetic user messages', () => {
      expect(isUserMessage(syntheticUserMessage)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isUserMessage(systemInitMessage)).toBe(false);
    });

    it('should return false for assistant messages', () => {
      expect(isUserMessage(assistantMessage)).toBe(false);
    });

    it('should return false for stream event messages', () => {
      expect(isUserMessage(streamEventMessage)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isUserMessage(resultMessage)).toBe(false);
    });
  });

  describe('isStreamEventMessage', () => {
    it('should return true for stream event messages', () => {
      expect(isStreamEventMessage(streamEventMessage)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isStreamEventMessage(systemInitMessage)).toBe(false);
    });

    it('should return false for assistant messages', () => {
      expect(isStreamEventMessage(assistantMessage)).toBe(false);
    });

    it('should return false for user messages', () => {
      expect(isStreamEventMessage(userMessage)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isStreamEventMessage(resultMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isStreamEventMessage(controlRequest)).toBe(false);
    });
  });

  describe('isResultMessage', () => {
    it('should return true for success result messages', () => {
      expect(isResultMessage(resultMessage)).toBe(true);
    });

    it('should return true for error result messages', () => {
      expect(isResultMessage(errorResultMessage)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isResultMessage(systemInitMessage)).toBe(false);
    });

    it('should return false for assistant messages', () => {
      expect(isResultMessage(assistantMessage)).toBe(false);
    });

    it('should return false for stream event messages', () => {
      expect(isResultMessage(streamEventMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isResultMessage(controlRequest)).toBe(false);
    });
  });

  describe('isControlRequest', () => {
    it('should return true for can_use_tool control requests', () => {
      expect(isControlRequest(controlRequest)).toBe(true);
    });

    it('should return true for hook_callback control requests', () => {
      expect(isControlRequest(hookCallbackControlRequest)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isControlRequest(systemInitMessage)).toBe(false);
    });

    it('should return false for assistant messages', () => {
      expect(isControlRequest(assistantMessage)).toBe(false);
    });

    it('should return false for control responses', () => {
      expect(isControlRequest(controlResponse)).toBe(false);
    });

    it('should return false for control cancel requests', () => {
      expect(isControlRequest(controlCancelRequest)).toBe(false);
    });
  });

  describe('isControlResponse', () => {
    it('should return true for control responses', () => {
      expect(isControlResponse(controlResponse)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isControlResponse(systemInitMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isControlResponse(controlRequest)).toBe(false);
    });

    it('should return false for control cancel requests', () => {
      expect(isControlResponse(controlCancelRequest)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isControlResponse(resultMessage)).toBe(false);
    });
  });

  describe('isControlCancelRequest', () => {
    it('should return true for control cancel requests', () => {
      expect(isControlCancelRequest(controlCancelRequest)).toBe(true);
    });

    it('should return false for system messages', () => {
      expect(isControlCancelRequest(systemInitMessage)).toBe(false);
    });

    it('should return false for control requests', () => {
      expect(isControlCancelRequest(controlRequest)).toBe(false);
    });

    it('should return false for control responses', () => {
      expect(isControlCancelRequest(controlResponse)).toBe(false);
    });

    it('should return false for result messages', () => {
      expect(isControlCancelRequest(resultMessage)).toBe(false);
    });
  });
});

// =============================================================================
// Content Type Guard Tests
// =============================================================================

describe('Content Type Guards', () => {
  describe('isTextContent', () => {
    it('should return true for text content', () => {
      expect(isTextContent(textContent)).toBe(true);
    });

    it('should return false for thinking content', () => {
      expect(isTextContent(thinkingContent)).toBe(false);
    });

    it('should return false for tool_use content', () => {
      expect(isTextContent(toolUseContent)).toBe(false);
    });

    it('should return false for tool_result content', () => {
      expect(isTextContent(toolResultContent)).toBe(false);
    });
  });

  describe('isThinkingContent', () => {
    it('should return true for thinking content', () => {
      expect(isThinkingContent(thinkingContent)).toBe(true);
    });

    it('should return false for text content', () => {
      expect(isThinkingContent(textContent)).toBe(false);
    });

    it('should return false for tool_use content', () => {
      expect(isThinkingContent(toolUseContent)).toBe(false);
    });

    it('should return false for tool_result content', () => {
      expect(isThinkingContent(toolResultContent)).toBe(false);
    });
  });

  describe('isToolUseContent', () => {
    it('should return true for tool_use content', () => {
      expect(isToolUseContent(toolUseContent)).toBe(true);
    });

    it('should return false for text content', () => {
      expect(isToolUseContent(textContent)).toBe(false);
    });

    it('should return false for thinking content', () => {
      expect(isToolUseContent(thinkingContent)).toBe(false);
    });

    it('should return false for tool_result content', () => {
      expect(isToolUseContent(toolResultContent)).toBe(false);
    });
  });

  describe('isToolResultContent', () => {
    it('should return true for tool_result content', () => {
      expect(isToolResultContent(toolResultContent)).toBe(true);
    });

    it('should return true for tool_result content with error', () => {
      expect(isToolResultContent(toolResultContentWithError)).toBe(true);
    });

    it('should return false for text content', () => {
      expect(isToolResultContent(textContent)).toBe(false);
    });

    it('should return false for thinking content', () => {
      expect(isToolResultContent(thinkingContent)).toBe(false);
    });

    it('should return false for tool_use content', () => {
      expect(isToolResultContent(toolUseContent)).toBe(false);
    });
  });
});

// =============================================================================
// Control Request Guard Tests
// =============================================================================

describe('Control Request Guards', () => {
  describe('isCanUseToolRequest', () => {
    it('should return true for can_use_tool requests', () => {
      expect(isCanUseToolRequest(canUseToolRequest)).toBe(true);
    });

    it('should return false for hook_callback requests', () => {
      expect(isCanUseToolRequest(hookCallbackRequest)).toBe(false);
    });

    it('should work with request extracted from ControlRequest', () => {
      const extracted = controlRequest.request;
      expect(isCanUseToolRequest(extracted)).toBe(true);
    });
  });

  describe('isHookCallbackRequest', () => {
    it('should return true for hook_callback requests', () => {
      expect(isHookCallbackRequest(hookCallbackRequest)).toBe(true);
    });

    it('should return false for can_use_tool requests', () => {
      expect(isHookCallbackRequest(canUseToolRequest)).toBe(false);
    });

    it('should work with request extracted from ControlRequest', () => {
      const extracted = hookCallbackControlRequest.request;
      expect(isHookCallbackRequest(extracted)).toBe(true);
    });
  });
});

// =============================================================================
// Stream Event Guard Tests
// =============================================================================

describe('Stream Event Guards', () => {
  describe('isMessageStartEvent', () => {
    it('should return true for message_start events', () => {
      expect(isMessageStartEvent(messageStartEvent)).toBe(true);
    });

    it('should return false for content_block_start events', () => {
      expect(isMessageStartEvent(contentBlockStartEvent)).toBe(false);
    });

    it('should return false for content_block_delta events', () => {
      expect(isMessageStartEvent(contentBlockDeltaEvent)).toBe(false);
    });

    it('should return false for message_stop events', () => {
      expect(isMessageStartEvent(messageStopEvent)).toBe(false);
    });
  });

  describe('isContentBlockStartEvent', () => {
    it('should return true for content_block_start events', () => {
      expect(isContentBlockStartEvent(contentBlockStartEvent)).toBe(true);
    });

    it('should return false for message_start events', () => {
      expect(isContentBlockStartEvent(messageStartEvent)).toBe(false);
    });

    it('should return false for content_block_delta events', () => {
      expect(isContentBlockStartEvent(contentBlockDeltaEvent)).toBe(false);
    });

    it('should return false for content_block_stop events', () => {
      expect(isContentBlockStartEvent(contentBlockStopEvent)).toBe(false);
    });
  });

  describe('isContentBlockDeltaEvent', () => {
    it('should return true for text delta events', () => {
      expect(isContentBlockDeltaEvent(contentBlockDeltaEvent)).toBe(true);
    });

    it('should return true for thinking delta events', () => {
      expect(isContentBlockDeltaEvent(thinkingDeltaEvent)).toBe(true);
    });

    it('should return false for message_start events', () => {
      expect(isContentBlockDeltaEvent(messageStartEvent)).toBe(false);
    });

    it('should return false for content_block_start events', () => {
      expect(isContentBlockDeltaEvent(contentBlockStartEvent)).toBe(false);
    });

    it('should return false for content_block_stop events', () => {
      expect(isContentBlockDeltaEvent(contentBlockStopEvent)).toBe(false);
    });

    it('should return false for message_delta events', () => {
      expect(isContentBlockDeltaEvent(messageDeltaEvent)).toBe(false);
    });
  });

  describe('isContentBlockStopEvent', () => {
    it('should return true for content_block_stop events', () => {
      expect(isContentBlockStopEvent(contentBlockStopEvent)).toBe(true);
    });

    it('should return false for content_block_start events', () => {
      expect(isContentBlockStopEvent(contentBlockStartEvent)).toBe(false);
    });

    it('should return false for content_block_delta events', () => {
      expect(isContentBlockStopEvent(contentBlockDeltaEvent)).toBe(false);
    });

    it('should return false for message_stop events', () => {
      expect(isContentBlockStopEvent(messageStopEvent)).toBe(false);
    });
  });

  describe('isMessageDeltaEvent', () => {
    it('should return true for message_delta events', () => {
      expect(isMessageDeltaEvent(messageDeltaEvent)).toBe(true);
    });

    it('should return false for message_start events', () => {
      expect(isMessageDeltaEvent(messageStartEvent)).toBe(false);
    });

    it('should return false for content_block_delta events', () => {
      expect(isMessageDeltaEvent(contentBlockDeltaEvent)).toBe(false);
    });

    it('should return false for message_stop events', () => {
      expect(isMessageDeltaEvent(messageStopEvent)).toBe(false);
    });
  });

  describe('isMessageStopEvent', () => {
    it('should return true for message_stop events', () => {
      expect(isMessageStopEvent(messageStopEvent)).toBe(true);
    });

    it('should return false for message_start events', () => {
      expect(isMessageStopEvent(messageStartEvent)).toBe(false);
    });

    it('should return false for message_delta events', () => {
      expect(isMessageStopEvent(messageDeltaEvent)).toBe(false);
    });

    it('should return false for content_block_stop events', () => {
      expect(isMessageStopEvent(contentBlockStopEvent)).toBe(false);
    });
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Edge Cases', () => {
  describe('messages with minimal fields', () => {
    it('should identify system message with only type field', () => {
      const minimal: ClaudeJson = { type: 'system' };
      expect(isSystemMessage(minimal)).toBe(true);
    });

    it('should identify result message with only type field', () => {
      const minimal: ClaudeJson = { type: 'result' };
      expect(isResultMessage(minimal)).toBe(true);
    });
  });

  describe('stream event extraction from StreamEventMessage', () => {
    it('should correctly identify event type from StreamEventMessage', () => {
      const extracted = streamEventMessage.event;
      expect(isContentBlockDeltaEvent(extracted)).toBe(true);
    });
  });

  describe('content items from assistant message', () => {
    it('should identify content types within assistant message content array', () => {
      const msg: AssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [textContent, toolUseContent],
        },
      };

      const contentItems = msg.message.content as ClaudeContentItem[];
      expect(isTextContent(contentItems[0])).toBe(true);
      expect(isToolUseContent(contentItems[1])).toBe(true);
    });
  });

  describe('control request with permission suggestions', () => {
    it('should identify can_use_tool request with permission suggestions', () => {
      const requestWithSuggestions: CanUseToolRequest = {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        input: { file_path: '/src/file.ts', old_string: 'a', new_string: 'b' },
        permission_suggestions: [{ type: 'addRules', rules: [{ tool_name: 'Edit' }] }],
      };
      expect(isCanUseToolRequest(requestWithSuggestions)).toBe(true);
    });
  });

  describe('hook callback with tool info', () => {
    it('should identify hook_callback request with PreToolUse event', () => {
      const preToolUseHook: HookCallbackRequest = {
        subtype: 'hook_callback',
        callback_id: 'cb-123',
        input: {
          session_id: 'sess-1',
          transcript_path: '/path/to/transcript.json',
          cwd: '/project',
          permission_mode: 'default',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          tool_use_id: 'tool-999',
        },
      };
      expect(isHookCallbackRequest(preToolUseHook)).toBe(true);
    });
  });
});
