import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

describeRuleFixtures('no-tool-input-cast', {
  rejected: [
    'const todos = input.todos as Todo[] | undefined;',
    'const path = (input.file_path as string) ?? "";',
    'const offset = input?.["offset"] as number;',
    'const path = call.input.file_path as string;',
    'const payload = input as unknown as Payload;',
    'const todos = input!.todos as Todo[];',
    'const path = call.input!.file_path as string;',
    'const delta = event.delta as InputJsonDelta | typeof event.delta;',
    'const block = event.content_block as ToolUseContent;',
    'const json = (message.event?.delta as InputJsonDelta).partial_json;',
  ],
  accepted: [
    'const parsed = parseToolInput(readToolInputSchema, input);',
    'const keys = ["file_path", "offset"] as const;',
    'const textarea = inputRef.current as HTMLTextAreaElement;',
    'const name = tool.name as string;',
    'const block = ToolUseBlockIdSchema.safeParse(event.content_block);',
    'const delta = event.delta;',
  ],
});

describe('tool input casts', () => {
  const projectConfig = readProjectConfig();

  it('applies to the chat feature, renderers and reducer path, without file exceptions', () => {
    const scopes = projectConfig.overrides
      .filter((override) => override.rules['factory/no-tool-input-cast'] !== undefined)
      .map((override) => [override.files, override.rules['factory/no-tool-input-cast']]);
    expect(scopes).toEqual([[['src/client/features/chat/**/*.{ts,tsx}'], 'error']]);
  });
});
