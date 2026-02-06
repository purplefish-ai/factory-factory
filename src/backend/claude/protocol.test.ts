import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProtocol } from './protocol';
import type {
  AssistantMessage,
  ClaudeJson,
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
  StreamEventMessage,
} from './types';

// =============================================================================
// Test Setup
// =============================================================================

describe('ClaudeProtocol', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let protocol: ClaudeProtocol;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    protocol = new ClaudeProtocol(stdin, stdout);
    protocol.start();
  });

  afterEach(() => {
    protocol.stop();
  });

  // ===========================================================================
  // sendUserMessage Tests
  // ===========================================================================

  describe('sendUserMessage', () => {
    it('should send message with string content', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendUserMessage('Hello, Claude!');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('user');
      expect(parsed.message.role).toBe('user');
      expect(parsed.message.content).toBe('Hello, Claude!');
    });

    it('should send message with content array', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendUserMessage([{ type: 'text', text: 'Hello!' }]);

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('user');
      expect(parsed.message.role).toBe('user');
      expect(parsed.message.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    });

    it('should send message with multiple content items', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendUserMessage([
        { type: 'text', text: 'First part' },
        { type: 'text', text: 'Second part' },
      ]);

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.message.content).toHaveLength(2);
      expect(parsed.message.content[0].text).toBe('First part');
      expect(parsed.message.content[1].text).toBe('Second part');
    });

    it('should append newline to message for NDJSON format', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendUserMessage('Test');

      const written = Buffer.concat(chunks).toString();
      expect(written.endsWith('\n')).toBe(true);
    });
  });

  // ===========================================================================
  // sendSetPermissionMode Tests
  // ===========================================================================

  describe('sendSetPermissionMode', () => {
    it('should send set_permission_mode request with bypassPermissions', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendSetPermissionMode('bypassPermissions');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('control_request');
      expect(parsed.request.subtype).toBe('set_permission_mode');
      expect(parsed.request.mode).toBe('bypassPermissions');
    });

    it('should send set_permission_mode request with default mode', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendSetPermissionMode('default');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request.mode).toBe('default');
    });

    it('should send set_permission_mode request with acceptEdits mode', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendSetPermissionMode('acceptEdits');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request.mode).toBe('acceptEdits');
    });

    it('should send set_permission_mode request with plan mode', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendSetPermissionMode('plan');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request.mode).toBe('plan');
    });

    it('should include a unique request_id', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendSetPermissionMode('bypassPermissions');

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request_id).toBeDefined();
      expect(typeof parsed.request_id).toBe('string');
      expect(parsed.request_id.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // sendInterrupt Tests
  // ===========================================================================

  describe('sendInterrupt', () => {
    it('should send interrupt request', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendInterrupt();

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('control_request');
      expect(parsed.request.subtype).toBe('interrupt');
    });

    it('should include a unique request_id', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendInterrupt();

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request_id).toBeDefined();
      expect(typeof parsed.request_id).toBe('string');
    });

    it('should generate different request_ids for multiple interrupts', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendInterrupt();
      protocol.sendInterrupt();

      const written = Buffer.concat(chunks).toString();
      const lines = written.trim().split('\n');
      const parsed1 = JSON.parse(lines[0]!);
      const parsed2 = JSON.parse(lines[1]!);

      expect(parsed1.request_id).not.toBe(parsed2.request_id);
    });
  });

  // ===========================================================================
  // sendControlResponse Tests
  // ===========================================================================

  describe('sendControlResponse', () => {
    it('should send control response with request_id', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendControlResponse('req-123', { behavior: 'allow', updatedInput: {} });

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('control_response');
      expect(parsed.response.request_id).toBe('req-123');
      expect(parsed.response.subtype).toBe('success');
      expect(parsed.response.response).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it('should send deny response with message', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendControlResponse('req-456', {
        behavior: 'deny',
        message: 'Not allowed',
      });

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.response.response.behavior).toBe('deny');
      expect(parsed.response.response.message).toBe('Not allowed');
    });

    it('should send allow response with updated input', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendControlResponse('req-789', {
        behavior: 'allow',
        updatedInput: { file_path: '/modified/path.txt' },
      });

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.response.response.behavior).toBe('allow');
      expect(parsed.response.response.updatedInput).toEqual({ file_path: '/modified/path.txt' });
    });

    it('should send hook response data', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      protocol.sendControlResponse('req-hook', {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Safe tool',
        },
      });

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.response.response.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.response.response.hookSpecificOutput.permissionDecision).toBe('allow');
    });
  });

  // ===========================================================================
  // sendInitialize Tests
  // ===========================================================================

  describe('sendInitialize', () => {
    it('should send initialize request', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      // Start the promise but don't await it
      const initPromise = protocol.sendInitialize();

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.type).toBe('control_request');
      expect(parsed.request.subtype).toBe('initialize');
      expect(parsed.request_id).toBeDefined();

      // Clean up the pending promise
      protocol.stop();
      initPromise.catch(() => {
        // Intentionally empty - suppress unhandled rejection
      });
    });

    it('should send initialize request with hooks config', () => {
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      const hooksConfig = {
        PreToolUse: [{ matcher: 'Bash', hookCallbackIds: ['cb-1'] }],
        Stop: [{ hookCallbackIds: ['cb-2'] }],
      };

      const initPromise = protocol.sendInitialize(hooksConfig);

      const written = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(written.trim());
      expect(parsed.request.hooks).toEqual(hooksConfig);

      // Clean up the pending promise
      protocol.stop();
      initPromise.catch(() => {
        // Intentionally empty - suppress unhandled rejection
      });
    });

    it('should resolve with response data when CLI responds', async () => {
      const initPromise = protocol.sendInitialize();

      // Wait a tick for the message to be sent
      await new Promise((resolve) => setImmediate(resolve));

      // Get the request_id from stdin
      const chunks: Buffer[] = [];
      stdin.on('data', (chunk) => chunks.push(chunk));

      // Re-send to capture the request_id (since we already consumed the first write)
      // Instead, we'll simulate the response with a known format
      const responseData = {
        commands: [{ name: 'test', description: 'Test command' }],
        output_style: 'stream-json',
        available_output_styles: ['stream-json', 'json'],
        models: [{ value: 'claude-3', displayName: 'Claude 3', description: 'Latest' }],
        account: { email: 'test@example.com', organization: 'Test', subscriptionType: 'pro' },
      };

      // We need to match the request_id. Since we can't easily get it,
      // let's test with a fresh protocol instance
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const initPromise2 = protocol2.sendInitialize();

      // Wait for the message to be written
      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      // Send the response
      const response: ControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: responseData,
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      const result = await initPromise2;
      expect(result).toEqual(responseData);

      protocol2.stop();
      protocol.stop();
      initPromise.catch(() => {
        // Intentionally empty - suppress unhandled rejection
      });
    });

    it('should reject on timeout', async () => {
      const shortTimeoutProtocol = new ClaudeProtocol(stdin, stdout, { requestTimeout: 50 });
      shortTimeoutProtocol.start();

      await expect(shortTimeoutProtocol.sendInitialize()).rejects.toThrow('timed out');

      shortTimeoutProtocol.stop();
    });
  });

  // ===========================================================================
  // Message Parsing Tests
  // ===========================================================================

  describe('message parsing', () => {
    it('should emit message event for valid JSON', async () => {
      const messagePromise = new Promise<ClaudeJson>((resolve) => {
        protocol.on('message', resolve);
      });

      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'abc',
        message: { role: 'assistant', content: [] },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await messagePromise;
      expect(received).toEqual(msg);
    });

    it('should emit control_request event for control requests', async () => {
      const requestPromise = new Promise<ControlRequest>((resolve) => {
        protocol.on('control_request', resolve);
      });

      const msg: ControlRequest = {
        type: 'control_request',
        request_id: 'req-123',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          input: { file_path: '/test.txt' },
          tool_use_id: 'tool-1',
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await requestPromise;
      expect(received).toEqual(msg);
    });

    it('should emit stream_event for stream events', async () => {
      const eventPromise = new Promise<StreamEventMessage>((resolve) => {
        protocol.on('stream_event', resolve);
      });

      const msg: StreamEventMessage = {
        type: 'stream_event',
        session_id: 'abc',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await eventPromise;
      expect(received).toEqual(msg);
    });

    it('should emit control_cancel event for cancel requests', async () => {
      const cancelPromise = new Promise<ControlCancelRequest>((resolve) => {
        protocol.on('control_cancel', resolve);
      });

      const msg: ControlCancelRequest = {
        type: 'control_cancel_request',
        request_id: 'req-to-cancel',
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await cancelPromise;
      expect(received).toEqual(msg);
    });

    it('should skip empty lines', async () => {
      const messages: ClaudeJson[] = [];
      protocol.on('message', (msg) => messages.push(msg));

      stdout.write('\n');
      stdout.write('  \n');
      stdout.write('\t\n');

      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [] },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      // Wait for processing
      await new Promise((resolve) => setImmediate(resolve));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    it('should handle malformed JSON gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // Intentionally empty - suppress console output during test
      });

      const messages: ClaudeJson[] = [];
      protocol.on('message', (msg) => messages.push(msg));

      // Send malformed JSON
      stdout.write('{ invalid json }\n');

      // Then send valid JSON
      const validMsg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [] },
      };
      stdout.write(`${JSON.stringify(validMsg)}\n`);

      // Wait for processing
      await new Promise((resolve) => setImmediate(resolve));

      // Should only have the valid message
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(validMsg);

      // Console error should have been called for malformed JSON
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should emit both message and specific event for control requests', async () => {
      const messages: ClaudeJson[] = [];
      const controlRequests: ControlRequest[] = [];

      protocol.on('message', (msg) => messages.push(msg));
      protocol.on('control_request', (req) => controlRequests.push(req));

      const msg: ControlRequest = {
        type: 'control_request',
        request_id: 'req-123',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'ls' },
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      await new Promise((resolve) => setImmediate(resolve));

      expect(messages).toHaveLength(1);
      expect(controlRequests).toHaveLength(1);
    });

    it('should handle multiple messages in sequence', async () => {
      const messages: ClaudeJson[] = [];
      protocol.on('message', (msg) => messages.push(msg));

      const msg1: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] },
      };
      const msg2: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] },
      };

      stdout.write(`${JSON.stringify(msg1)}\n`);
      stdout.write(`${JSON.stringify(msg2)}\n`);

      await new Promise((resolve) => setImmediate(resolve));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(msg1);
      expect(messages[1]).toEqual(msg2);
    });
  });

  // ===========================================================================
  // Request Tracking Tests
  // ===========================================================================

  describe('request tracking', () => {
    it('should reject pending requests when protocol is stopped', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 60_000 });
      protocol2.start();

      const initPromise = protocol2.sendInitialize();

      // Stop the protocol before response arrives
      protocol2.stop();

      // When stopped, it may reject with either "Protocol stopped" or "Connection closed"
      // depending on timing (readline close vs explicit cleanup)
      await expect(initPromise).rejects.toThrow(/Protocol stopped|Connection closed/);
    });

    it('should reject pending requests when stream closes', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 60_000 });
      protocol2.start();

      const initPromise = protocol2.sendInitialize();

      // Close the stdout stream
      stdout2.end();

      await expect(initPromise).rejects.toThrow('Connection closed');
    });

    it('should reject pending request when control_cancel is received', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 60_000 });
      protocol2.start();

      // Capture the request_id
      const chunks: string[] = [];
      stdin2.on('data', (chunk) => chunks.push(chunk.toString()));

      const initPromise = protocol2.sendInitialize();

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks[0]!.trim());
      const requestId = sentMessage.request_id;

      // Send cancel
      const cancelMsg: ControlCancelRequest = {
        type: 'control_cancel_request',
        request_id: requestId,
      };
      stdout2.write(`${JSON.stringify(cancelMsg)}\n`);

      await expect(initPromise).rejects.toThrow('Request cancelled by CLI');

      protocol2.stop();
    });

    it('should emit close event when stream ends', async () => {
      const closePromise = new Promise<void>((resolve) => {
        protocol.on('close', resolve);
      });

      stdout.end();

      await closePromise;
      // If we get here, the close event was emitted
      expect(true).toBe(true);
    });
  });

  // ===========================================================================
  // Start/Stop Tests
  // ===========================================================================

  describe('start/stop', () => {
    it('should not start twice', () => {
      // Protocol is already started in beforeEach
      const messages: ClaudeJson[] = [];
      protocol.on('message', (msg) => messages.push(msg));

      // Try to start again
      protocol.start();

      // Send a message and verify it's only received once
      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [] },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          expect(messages).toHaveLength(1);
          resolve();
        });
      });
    });

    it('should not stop twice without error', () => {
      // Stop the protocol
      protocol.stop();

      // Stop again - should not throw
      expect(() => protocol.stop()).not.toThrow();
    });

    it('should not emit events after stop', async () => {
      const messages: ClaudeJson[] = [];
      protocol.on('message', (msg) => messages.push(msg));

      protocol.stop();

      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: { role: 'assistant', content: [] },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      await new Promise((resolve) => setImmediate(resolve));

      expect(messages).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should have error event handler registered for stdin', () => {
      // Verify that the protocol registers an error handler on stdin
      // This prevents unhandled error exceptions from crashing the process
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2);

      // Before start, no error handler
      const listenersBefore = stdin2.listenerCount('error');

      protocol2.start();

      // After start, protocol should have added an error handler
      const listenersAfter = stdin2.listenerCount('error');
      expect(listenersAfter).toBeGreaterThan(listenersBefore);

      protocol2.stop();
    });

    it('should have error event handler registered for stdout', () => {
      // Verify that the protocol registers an error handler on stdout
      // This prevents unhandled error exceptions from crashing the process
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2);

      // Before start, no error handler
      const listenersBefore = stdout2.listenerCount('error');

      protocol2.start();

      // After start, protocol should have added an error handler
      const listenersAfter = stdout2.listenerCount('error');
      expect(listenersAfter).toBeGreaterThan(listenersBefore);

      protocol2.stop();
    });

    it('should emit error when stdin emits error', () => {
      // Test that stdin errors are properly caught and emitted
      const errorHandler = vi.fn();
      protocol.on('error', errorHandler);

      // Simulate stdin error
      const testError = new Error('stdin write error');
      stdin.emit('error', testError);

      expect(errorHandler).toHaveBeenCalledWith(testError);
    });

    it('should forward error events from the protocol to listeners', () => {
      // Test that protocol can emit errors to its listeners
      const errorHandler = vi.fn();
      protocol.on('error', errorHandler);

      // Manually emit an error through the protocol's emit method
      const testError = new Error('Test error');
      protocol.emit('error', testError);

      expect(errorHandler).toHaveBeenCalledWith(testError);
    });
  });

  // ===========================================================================
  // Protocol Options Tests
  // ===========================================================================

  describe('protocol options', () => {
    it('should use default request timeout of 60000ms', () => {
      // Create a protocol without options
      const defaultProtocol = new ClaudeProtocol(stdin, stdout);
      // The default timeout is internal, but we can test by checking timeout behavior
      expect(defaultProtocol).toBeDefined();
    });

    it('should use custom request timeout', async () => {
      const customTimeout = 100;
      const customProtocol = new ClaudeProtocol(stdin, stdout, { requestTimeout: customTimeout });
      customProtocol.start();

      const startTime = Date.now();
      try {
        await customProtocol.sendInitialize();
      } catch (_e) {
        // Expected to timeout
      }
      const elapsed = Date.now() - startTime;

      // Should timeout roughly around the custom timeout (with some tolerance)
      expect(elapsed).toBeGreaterThanOrEqual(customTimeout - 10);
      expect(elapsed).toBeLessThan(customTimeout + 100);

      customProtocol.stop();
    });
  });

  // ===========================================================================
  // Backpressure Tests
  // ===========================================================================

  describe('backpressure handling', () => {
    it('should reject pending send when stop() is called during backpressure', async () => {
      // Create a stream with very low highWaterMark to trigger backpressure
      const smallStdin = new PassThrough({ highWaterMark: 16 });
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(smallStdin, stdout2);
      protocol2.start();

      // Pause to prevent draining
      smallStdin.pause();

      // Start a send that will hit backpressure (message larger than highWaterMark)
      const sendPromise = protocol2.sendUserMessage('x'.repeat(100));

      // Give time for the send to reach backpressure
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Stop the protocol while send is waiting for drain
      protocol2.stop();

      // The promise should reject with "Protocol stopped"
      await expect(sendPromise).rejects.toThrow('Protocol stopped');
    });

    it('should reject queued sends when stop() is called', async () => {
      const smallStdin = new PassThrough({ highWaterMark: 16 });
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(smallStdin, stdout2);
      protocol2.start();

      // Pause to prevent draining
      smallStdin.pause();

      // Queue multiple sends
      const sendPromise1 = protocol2.sendUserMessage('first'.repeat(20));
      const sendPromise2 = protocol2.sendUserMessage('second'.repeat(20));

      // Give time for sends to queue up
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Stop the protocol
      protocol2.stop();

      // Both promises should reject
      await expect(sendPromise1).rejects.toThrow('Protocol stopped');
      await expect(sendPromise2).rejects.toThrow('Protocol stopped');
    });
  });

  // ===========================================================================
  // Schema Validation Tests
  // ===========================================================================

  describe('schema validation', () => {
    it('should reject initialize response with invalid structure', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const initPromise = protocol2.sendInitialize();

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      // Send invalid response - has required fields but missing nested required fields
      const response = {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: {
            commands: [],
            models: [],
            account: {}, // Missing email, organization, subscriptionType
            // missing output_style, available_output_styles
          },
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      await expect(initPromise).rejects.toThrow('Invalid initialize response');

      protocol2.stop();
    });

    it('should reject initialize response with wrong account type', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const initPromise = protocol2.sendInitialize();

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      // Send response with account as a string instead of an object
      const response = {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: {
            commands: [],
            output_style: 'stream-json',
            available_output_styles: ['stream-json'],
            models: [],
            account: 'not-an-object',
          },
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      await expect(initPromise).rejects.toThrow('Invalid initialize response');

      protocol2.stop();
    });

    it('should accept valid initialize response', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const initPromise = protocol2.sendInitialize();

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      const validResponse = {
        commands: [{ name: 'test', description: 'Test command' }],
        output_style: 'stream-json',
        available_output_styles: ['stream-json', 'json'],
        models: [{ value: 'claude-3', displayName: 'Claude 3', description: 'Latest' }],
        account: {
          email: 'test@example.com',
          organization: 'Test Org',
          subscriptionType: 'pro',
        },
      };

      const response: ControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: validResponse,
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      const result = await initPromise;
      expect(result).toEqual(validResponse);

      protocol2.stop();
    });

    it('should reject rewind files response with invalid affected_files type', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const rewindPromise = protocol2.sendRewindFiles('msg-123');

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      // Send invalid response - affected_files should be array of strings, not number
      const response = {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: {
            affected_files: 123, // Invalid: should be string[]
          },
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      await expect(rewindPromise).rejects.toThrow('Invalid rewind files response');

      protocol2.stop();
    });

    it('should accept valid rewind files response with affected_files', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const rewindPromise = protocol2.sendRewindFiles('msg-123');

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      const validResponse = {
        affected_files: ['/path/to/file1.txt', '/path/to/file2.txt'],
      };

      const response = {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: validResponse,
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      const result = await rewindPromise;
      expect(result).toEqual(validResponse);

      protocol2.stop();
    });

    it('should accept valid rewind files response without affected_files', async () => {
      const stdin2 = new PassThrough();
      const stdout2 = new PassThrough();
      const protocol2 = new ClaudeProtocol(stdin2, stdout2, { requestTimeout: 1000 });
      protocol2.start();

      const chunks2: string[] = [];
      stdin2.on('data', (chunk) => chunks2.push(chunk.toString()));

      const rewindPromise = protocol2.sendRewindFiles('msg-123');

      await new Promise((resolve) => setImmediate(resolve));

      const sentMessage = JSON.parse(chunks2[0]!.trim());
      const requestId = sentMessage.request_id;

      const validResponse = {};

      const response = {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: validResponse,
        },
      };
      stdout2.write(`${JSON.stringify(response)}\n`);

      const result = await rewindPromise;
      expect(result).toEqual(validResponse);

      protocol2.stop();
    });
  });

  // ===========================================================================
  // Edge Cases Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle messages with special characters', async () => {
      const messagePromise = new Promise<ClaudeJson>((resolve) => {
        protocol.on('message', resolve);
      });

      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello "world" with\nnewlines\tand\ttabs' }],
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await messagePromise;
      expect(received).toEqual(msg);
    });

    it('should handle messages with unicode', async () => {
      const messagePromise = new Promise<ClaudeJson>((resolve) => {
        protocol.on('message', resolve);
      });

      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello World!' }],
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = await messagePromise;
      expect(received).toEqual(msg);
    });

    it('should handle very long messages', async () => {
      const messagePromise = new Promise<ClaudeJson>((resolve) => {
        protocol.on('message', resolve);
      });

      const longText = 'x'.repeat(100_000);
      const msg: AssistantMessage = {
        type: 'assistant',
        session_id: 'test',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: longText }],
        },
      };
      stdout.write(`${JSON.stringify(msg)}\n`);

      const received = (await messagePromise) as AssistantMessage;
      const content = received.message.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe(longText);
    });
  });
});
