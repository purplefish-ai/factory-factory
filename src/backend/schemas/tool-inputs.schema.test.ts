import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AskUserQuestionInputSchema,
  CommandToolInputSchema,
  ExitPlanModeInputSchema,
  extractInputValue,
  HookCallbackInputSchema,
  isArray,
  isString,
  safeParseToolInput,
  TaskToolInputSchema,
  type ValidationLogger,
} from './tool-inputs.schema';

// =============================================================================
// ExitPlanMode Schema Tests
// =============================================================================

describe('ExitPlanModeInputSchema', () => {
  it('accepts inline plan content (SDK format)', () => {
    const input = {
      plan: '# My Plan\n\n## Steps\n1. Do this\n2. Do that',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan).toBe('# My Plan\n\n## Steps\n1. Do this\n2. Do that');
      expect(result.data.planFile).toBeUndefined();
      expect(result.data.allowedPrompts).toHaveLength(1);
    }
  });

  it('accepts planFile path (CLI format)', () => {
    const input = {
      planFile: '/Users/dev/.claude/plans/example.md',
      allowedPrompts: [{ tool: 'Bash', prompt: 'install dependencies' }],
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.planFile).toBe('/Users/dev/.claude/plans/example.md');
      expect(result.data.plan).toBeUndefined();
    }
  });

  it('accepts both plan and planFile (edge case)', () => {
    const input = {
      plan: 'inline content',
      planFile: '/path/to/file.md',
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts empty input', () => {
    const result = ExitPlanModeInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts allowedPrompts without plan content', () => {
    const input = {
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'build project' },
      ],
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedPrompts).toHaveLength(2);
    }
  });

  it('rejects invalid allowedPrompts structure', () => {
    const input = {
      plan: 'content',
      allowedPrompts: [{ invalidKey: 'value' }],
    };
    const result = ExitPlanModeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// AskUserQuestion Schema Tests
// =============================================================================

describe('AskUserQuestionInputSchema', () => {
  it('validates questions array', () => {
    const input = {
      questions: [
        {
          question: 'Which framework do you prefer?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Popular UI library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multiSelect: false,
        },
      ],
    };
    const result = AskUserQuestionInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions).toHaveLength(1);
      expect(result.data.questions[0].question).toBe('Which framework do you prefer?');
      expect(result.data.questions[0].options).toHaveLength(2);
    }
  });

  it('requires label and description on options', () => {
    const input = {
      questions: [
        {
          question: 'Test?',
          options: [{ label: 'Option 1' }], // Missing description
        },
      ],
    };
    const result = AskUserQuestionInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts questions without optional fields', () => {
    const input = {
      questions: [
        {
          question: 'Choose one:',
          options: [
            { label: 'A', description: 'First option' },
            { label: 'B', description: 'Second option' },
          ],
        },
      ],
    };
    const result = AskUserQuestionInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions[0].header).toBeUndefined();
      expect(result.data.questions[0].multiSelect).toBeUndefined();
    }
  });

  it('accepts multiple questions', () => {
    const input = {
      questions: [
        {
          question: 'First question?',
          options: [{ label: 'Yes', description: 'Affirmative' }],
        },
        {
          question: 'Second question?',
          options: [{ label: 'No', description: 'Negative' }],
          multiSelect: true,
        },
      ],
    };
    const result = AskUserQuestionInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions).toHaveLength(2);
    }
  });

  it('rejects missing questions array', () => {
    const result = AskUserQuestionInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts empty questions array (validation passes, but callers should check length)', () => {
    const result = AskUserQuestionInputSchema.safeParse({ questions: [] });
    // Schema allows empty array - callers are responsible for checking length
    // and handling empty questions appropriately (e.g., denying the request)
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Task Tool Schema Tests
// =============================================================================

describe('TaskToolInputSchema', () => {
  it('accepts full task input', () => {
    const input = {
      subagent_type: 'Explore',
      description: 'Find all test files',
      prompt: 'Search for test files in the codebase',
      model: 'sonnet',
      max_turns: 10,
      run_in_background: true,
      resume: 'agent-123',
    };
    const result = TaskToolInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts minimal task input', () => {
    const result = TaskToolInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts partial task input', () => {
    const input = {
      subagent_type: 'Plan',
      prompt: 'Plan the implementation',
    };
    const result = TaskToolInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagent_type).toBe('Plan');
      expect(result.data.prompt).toBe('Plan the implementation');
      expect(result.data.model).toBeUndefined();
    }
  });
});

// =============================================================================
// Command Tool Schema Tests
// =============================================================================

describe('CommandToolInputSchema', () => {
  it('accepts full command input', () => {
    const input = {
      command: 'npm test',
      description: 'Run test suite',
      timeout: 60_000,
    };
    const result = CommandToolInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.command).toBe('npm test');
      expect(result.data.description).toBe('Run test suite');
      expect(result.data.timeout).toBe(60_000);
    }
  });

  it('accepts command-only input', () => {
    const input = { command: 'git status' };
    const result = CommandToolInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts empty input', () => {
    const result = CommandToolInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Hook Callback Schema Tests
// =============================================================================

describe('HookCallbackInputSchema', () => {
  it('validates complete hook callback input', () => {
    const input = {
      session_id: 'sess-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/project',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_use_id: 'tool-456',
      stop_hook_active: false,
    };
    const result = HookCallbackInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates minimal required fields', () => {
    const input = {
      session_id: 'sess-123',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/project',
      permission_mode: 'default',
      hook_event_name: 'Stop',
    };
    const result = HookCallbackInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBeUndefined();
      expect(result.data.tool_input).toBeUndefined();
    }
  });

  it('rejects missing required fields', () => {
    const input = {
      session_id: 'sess-123',
      // Missing other required fields
    };
    const result = HookCallbackInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// safeParseToolInput Utility Tests
// =============================================================================

describe('safeParseToolInput', () => {
  const mockLogger: ValidationLogger = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success with valid input', () => {
    const input = { command: 'npm test' };
    const result = safeParseToolInput(CommandToolInputSchema, input, 'Bash', mockLogger);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ command: 'npm test' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns failure with invalid input and logs warning', () => {
    const input = {
      questions: 'invalid', // Should be array
    };
    const result = safeParseToolInput(
      AskUserQuestionInputSchema,
      input,
      'AskUserQuestion',
      mockLogger
    );
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[Tool Input] AskUserQuestion input validation failed',
      expect.objectContaining({
        toolName: 'AskUserQuestion',
        errors: expect.any(Array),
        inputKeys: expect.any(Array),
      })
    );
  });

  it('works without logger', () => {
    const input = { invalid: true };
    const result = safeParseToolInput(HookCallbackInputSchema, input, 'HookCallback');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it('handles non-object input', () => {
    const result = safeParseToolInput(CommandToolInputSchema, 'not an object', 'Bash', mockLogger);
    expect(result.success).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('handles null input', () => {
    const result = safeParseToolInput(CommandToolInputSchema, null, 'Bash', mockLogger);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// extractInputValue Utility Tests
// =============================================================================

describe('extractInputValue', () => {
  const mockLogger: ValidationLogger = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts string value correctly', () => {
    const input = { command: 'npm test', timeout: 5000 };
    const result = extractInputValue(input, 'command', isString, 'Bash', mockLogger);
    expect(result).toBe('npm test');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined for missing key', () => {
    const input = { command: 'npm test' };
    const result = extractInputValue(input, 'description', isString, 'Bash', mockLogger);
    expect(result).toBeUndefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and logs warning for wrong type', () => {
    const input = { command: 123 };
    const result = extractInputValue(input, 'command', isString, 'Bash', mockLogger);
    expect(result).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[Tool Input] Bash.command has unexpected type',
      expect.objectContaining({
        toolName: 'Bash',
        key: 'command',
        actualType: 'number',
      })
    );
  });

  it('extracts array value correctly', () => {
    const input = { items: [1, 2, 3] };
    const result = extractInputValue(input, 'items', isArray, 'Test', mockLogger);
    expect(result).toEqual([1, 2, 3]);
  });
});

// =============================================================================
// Type Guard Tests
// =============================================================================

describe('Type Guards', () => {
  describe('isString', () => {
    it('returns true for strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString('')).toBe(true);
    });

    it('returns false for non-strings', () => {
      expect(isString(123)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
    });
  });

  describe('isArray', () => {
    it('returns true for arrays', () => {
      expect(isArray([])).toBe(true);
      expect(isArray([1, 2, 3])).toBe(true);
      expect(isArray(['a', 'b'])).toBe(true);
    });

    it('returns false for non-arrays', () => {
      expect(isArray('string')).toBe(false);
      expect(isArray(123)).toBe(false);
      expect(isArray(null)).toBe(false);
      expect(isArray(undefined)).toBe(false);
      expect(isArray({})).toBe(false);
    });
  });
});

// =============================================================================
// Real-World Input Format Tests
// =============================================================================

describe('Real-World Input Formats', () => {
  it('handles SDK ExitPlanMode format with inline plan', () => {
    // This is the format sent by the Claude SDK
    const sdkInput = {
      plan: `# Implementation Plan

## Summary
Implementing feature X

## Steps
1. Create component
2. Add tests
3. Update docs`,
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'install dependencies' },
      ],
    };

    const result = ExitPlanModeInputSchema.safeParse(sdkInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan).toContain('# Implementation Plan');
    }
  });

  it('handles CLI ExitPlanMode format with file path', () => {
    // This is the older CLI format with file path
    const cliInput = {
      planFile: '/Users/developer/.claude/plans/feature-x.md',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    };

    const result = ExitPlanModeInputSchema.safeParse(cliInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.planFile).toBe('/Users/developer/.claude/plans/feature-x.md');
    }
  });

  it('handles PreToolUse hook callback', () => {
    const hookInput = {
      session_id: 'abc-123-def-456',
      transcript_path: '/Users/dev/.claude/projects/-Users-dev-myproject/transcript.jsonl',
      cwd: '/Users/dev/myproject',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'rm -rf node_modules && npm install',
        description: 'Clean install dependencies',
      },
      tool_use_id: 'toolu_01ABC123',
    };

    const result = HookCallbackInputSchema.safeParse(hookInput);
    expect(result.success).toBe(true);
  });
});
