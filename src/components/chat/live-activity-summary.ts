import {
  extractCommandPreviewFromInput,
  getDisplayToolName,
  isRunLikeToolName,
} from '@/components/agent-activity/tool-renderers/tool-display-utils';
import type {
  GroupedMessageItem,
  PairedToolCall,
  ToolResultContentValue,
  ToolSequence,
} from '@/lib/chat-protocol';
import { isToolSequence } from '@/lib/chat-protocol';
import type { PendingRequest, ToolProgressInfo } from './reducer/types';

export interface LiveActivityNow {
  label: string;
  tone: 'muted' | 'default' | 'success' | 'error';
}

export interface LiveActivityMilestone {
  id: string;
  label: string;
  tone: 'muted' | 'default' | 'success' | 'error';
}

export interface LiveActivityFile {
  path: string;
  line?: number | null;
}

export interface LiveAttentionState {
  kind: 'permission' | 'question' | 'error';
  message: string;
}

export interface LiveActivitySummary {
  latestThinkingSnippet: string | null;
  now: LiveActivityNow;
  recent: LiveActivityMilestone[];
  filesTouched: LiveActivityFile[];
  hiddenFileCount: number;
  needsAttention: LiveAttentionState | null;
  latestToolSequence: ToolSequence | null;
  latestToolCall: PairedToolCall | null;
}

interface SummarizeLiveActivityParams {
  groupedMessages: GroupedMessageItem[];
  latestThinking: string | null;
  running: boolean;
  starting: boolean;
  stopping: boolean;
  pendingRequest: PendingRequest;
  permissionMode: string | null;
  toolProgress?: Map<string, ToolProgressInfo>;
}

const MAX_VISIBLE_FILES = 6;
const THINKING_SNIPPET_MAX_CHARS = 140;

const FILE_INPUT_KEYS = [
  'file_path',
  'path',
  'new_path',
  'old_path',
  'target_file',
  'target_path',
  'filePath',
  'filepath',
] as const;

const WRITER_TOOL_NAMES = ['write', 'edit', 'multiedit', 'notebookedit', 'replace'];
const READER_TOOL_NAMES = ['read', 'grep', 'glob', 'search'];

const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|mocha|pytest|cargo test|go test|pnpm test|npm test|yarn test|bun test)\b/i;
const TEST_FAILURE_PATTERN = /\b(fail(?:ed|ure|ing|ures)?|not ok)\b/i;
const NON_ZERO_TEST_FAILURE_PATTERN =
  /\b([1-9]\d*)\s+(?:tests?\s+)?(?:fail(?:ed|ure|ing|ures)?|errors?|not ok)\b/i;
const ZERO_TEST_FAILURE_PATTERN =
  /\b(?:0|no)\s+(?:tests?\s+)?(?:fail(?:ed|ure|ing|ures)?|errors?|not ok)\b/i;
const TEST_SUCCESS_PATTERN = /\b(all tests passed|0 failed|\d+\s+passed)\b/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function sanitizeThinkingLine(line: string): string {
  return normalizeWhitespace(line.replace(/^\*+|\*+$/g, ''));
}

export function toThinkingSnippet(thinking: string | null): string | null {
  if (!thinking) {
    return null;
  }

  const lines = thinking
    .split('\n')
    .map((line) => sanitizeThinkingLine(line))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const latestLine = lines[lines.length - 1];
  if (!latestLine) {
    return null;
  }

  return truncateWithEllipsis(latestLine, THINKING_SNIPPET_MAX_CHARS);
}

function getLatestToolSequence(groupedMessages: GroupedMessageItem[]): ToolSequence | null {
  for (let i = groupedMessages.length - 1; i >= 0; i -= 1) {
    const item = groupedMessages[i];
    if (item && isToolSequence(item)) {
      return item;
    }
  }
  return null;
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  const fileName = normalized.split('/').pop();
  return fileName && fileName.length > 0 ? fileName : path;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toContentText(content: ToolResultContentValue | undefined): string {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        const record = getRecord(entry);
        if (!record) {
          return '';
        }
        const textValue = record.text;
        if (typeof textValue === 'string') {
          return textValue;
        }
        const outputValue = record.output;
        if (typeof outputValue === 'string') {
          return outputValue;
        }
        return JSON.stringify(record);
      })
      .filter(Boolean)
      .join('\n');
  }

  const record = getRecord(content);
  if (!record) {
    return '';
  }

  const aggregated = record.aggregated_output;
  if (typeof aggregated === 'string') {
    return aggregated;
  }

  const stdout = record.stdout;
  if (typeof stdout === 'string') {
    return stdout;
  }

  const formatted = record.formatted_output;
  if (typeof formatted === 'string') {
    return formatted;
  }

  return JSON.stringify(record);
}

function getCommandPreview(call: PairedToolCall): string | null {
  const normalizedName = normalizeWhitespace(call.name).toLowerCase();
  if (!(isRunLikeToolName(call.name) || normalizedName === 'bash' || normalizedName === 'run')) {
    return null;
  }
  return extractCommandPreviewFromInput(call.input);
}

function findPrimaryPath(input: Record<string, unknown>): string | null {
  for (const key of FILE_INPUT_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized === '.' || normalized === '/') {
      continue;
    }
    return normalized;
  }

  const paths = input.paths;
  if (Array.isArray(paths)) {
    const firstPath = paths.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (typeof firstPath === 'string') {
      return firstPath.trim();
    }
  }

  return null;
}

function isWriteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return WRITER_TOOL_NAMES.some((prefix) => normalized.includes(prefix));
}

function isReadTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return READER_TOOL_NAMES.some((prefix) => normalized.includes(prefix));
}

function makeFileMilestone(call: PairedToolCall, filePath: string): LiveActivityMilestone {
  const fileName = getFileName(filePath);
  let verb = 'Touched';
  if (isWriteTool(call.name)) {
    verb = 'Edited';
  } else if (isReadTool(call.name)) {
    verb = 'Read';
  }
  return {
    id: `${call.id}-file`,
    label: `${verb} ${fileName}`,
    tone: 'default',
  };
}

function makeTestMilestone(
  call: PairedToolCall,
  commandPreview: string
): LiveActivityMilestone | null {
  if (!TEST_COMMAND_PATTERN.test(commandPreview) || call.status === 'pending') {
    return null;
  }

  if (call.status === 'error') {
    return {
      id: `${call.id}-test`,
      label: 'Tests failed',
      tone: 'error',
    };
  }

  const outputText = toContentText(call.result?.content).toLowerCase();
  const hasFailureSignal = TEST_FAILURE_PATTERN.test(outputText);
  const hasNonZeroFailureCount = NON_ZERO_TEST_FAILURE_PATTERN.test(outputText);
  const hasZeroFailureCount = ZERO_TEST_FAILURE_PATTERN.test(outputText);

  if (hasNonZeroFailureCount || (hasFailureSignal && !hasZeroFailureCount)) {
    return {
      id: `${call.id}-test`,
      label: 'Tests failed',
      tone: 'error',
    };
  }

  if (TEST_SUCCESS_PATTERN.test(outputText) || call.status === 'success') {
    return {
      id: `${call.id}-test`,
      label: 'Tests passed',
      tone: 'success',
    };
  }

  return null;
}

function compressMilestones(milestones: LiveActivityMilestone[]): LiveActivityMilestone[] {
  const compressed: LiveActivityMilestone[] = [];
  for (const milestone of milestones) {
    const previous = compressed[compressed.length - 1];
    if (previous && previous.label === milestone.label && previous.tone === milestone.tone) {
      continue;
    }
    compressed.push(milestone);
  }
  return compressed;
}

function forEachToolCall(
  groupedMessages: GroupedMessageItem[],
  visit: (call: PairedToolCall) => void
): void {
  for (const item of groupedMessages) {
    if (!isToolSequence(item)) {
      continue;
    }
    for (const call of item.pairedCalls) {
      visit(call);
    }
  }
}

function appendCallMilestones(milestones: LiveActivityMilestone[], call: PairedToolCall): void {
  const displayName = getDisplayToolName(call.name, call.input);

  milestones.push({
    id: `${call.id}-start`,
    label: `Started ${displayName}`,
    tone: 'muted',
  });

  if (call.status !== 'pending') {
    milestones.push({
      id: `${call.id}-done`,
      label: call.status === 'success' ? `Completed ${displayName}` : `Failed ${displayName}`,
      tone: call.status === 'success' ? 'success' : 'error',
    });
  }

  const filePath = findPrimaryPath(call.input);
  if (filePath) {
    milestones.push(makeFileMilestone(call, filePath));
  }

  const commandPreview = getCommandPreview(call);
  if (!commandPreview) {
    return;
  }

  const testMilestone = makeTestMilestone(call, commandPreview);
  if (testMilestone) {
    milestones.push(testMilestone);
  }
}

function extractMilestones(groupedMessages: GroupedMessageItem[]): LiveActivityMilestone[] {
  const milestones: LiveActivityMilestone[] = [];
  forEachToolCall(groupedMessages, (call) => {
    appendCallMilestones(milestones, call);
  });

  return compressMilestones(milestones);
}

function upsertRecentFile(files: LiveActivityFile[], file: LiveActivityFile): void {
  const existingIndex = files.findIndex((entry) => entry.path === file.path);
  if (existingIndex >= 0) {
    files.splice(existingIndex, 1);
  }
  files.push(file);
}

function appendProgressFiles(
  files: LiveActivityFile[],
  toolProgress?: Map<string, ToolProgressInfo>
): void {
  if (!toolProgress) {
    return;
  }

  for (const progress of toolProgress.values()) {
    if (!progress.acpLocations) {
      continue;
    }
    for (const location of progress.acpLocations) {
      if (!location.path || location.path === '.') {
        continue;
      }
      upsertRecentFile(files, { path: location.path, line: location.line });
    }
  }
}

function extractFilesTouched(
  groupedMessages: GroupedMessageItem[],
  toolProgress?: Map<string, ToolProgressInfo>
): { visibleFiles: LiveActivityFile[]; hiddenFileCount: number } {
  const files: LiveActivityFile[] = [];

  forEachToolCall(groupedMessages, (call) => {
    const path = findPrimaryPath(call.input);
    if (path) {
      upsertRecentFile(files, { path });
    }
  });

  appendProgressFiles(files, toolProgress);

  const visibleFiles = files.slice(-MAX_VISIBLE_FILES);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);

  return { visibleFiles, hiddenFileCount };
}

function buildNeedsAttention(
  pendingRequest: PendingRequest,
  latestToolCall: PairedToolCall | null
): LiveAttentionState | null {
  if (pendingRequest.type === 'permission') {
    return {
      kind: 'permission',
      message: `Approval required for ${pendingRequest.request.toolName}`,
    };
  }
  if (pendingRequest.type === 'question') {
    return {
      kind: 'question',
      message: 'Agent is waiting for your response',
    };
  }
  if (latestToolCall?.status === 'error') {
    return {
      kind: 'error',
      message: `Latest action failed: ${getDisplayToolName(
        latestToolCall.name,
        latestToolCall.input
      )}`,
    };
  }
  return null;
}

function buildNowState(params: {
  pendingRequest: PendingRequest;
  latestToolCall: PairedToolCall | null;
  running: boolean;
  starting: boolean;
  stopping: boolean;
  permissionMode: string | null;
  latestThinkingSnippet: string | null;
  latestMilestone: LiveActivityMilestone | null;
}): LiveActivityNow {
  const {
    pendingRequest,
    latestToolCall,
    running,
    starting,
    stopping,
    permissionMode,
    latestThinkingSnippet,
    latestMilestone,
  } = params;

  if (pendingRequest.type === 'permission') {
    return {
      label: `Waiting for approval: ${pendingRequest.request.toolName}`,
      tone: 'error',
    };
  }

  if (pendingRequest.type === 'question') {
    return {
      label: 'Waiting for your answer',
      tone: 'error',
    };
  }

  if (running && latestToolCall?.status === 'pending') {
    return {
      label: `Running ${getDisplayToolName(latestToolCall.name, latestToolCall.input)}`,
      tone: 'default',
    };
  }

  if (starting) {
    return { label: 'Starting session', tone: 'muted' };
  }

  if (stopping) {
    return { label: 'Stopping session', tone: 'muted' };
  }

  if (permissionMode) {
    return { label: `Waiting (${permissionMode})`, tone: 'muted' };
  }

  if (running && latestThinkingSnippet) {
    return { label: 'Thinking', tone: 'default' };
  }

  if (latestMilestone) {
    return {
      label: latestMilestone.label,
      tone: latestMilestone.tone,
    };
  }

  return running ? { label: 'Running', tone: 'default' } : { label: 'Idle', tone: 'muted' };
}

export function summarizeLiveActivity({
  groupedMessages,
  latestThinking,
  running,
  starting,
  stopping,
  pendingRequest,
  permissionMode,
  toolProgress,
}: SummarizeLiveActivityParams): LiveActivitySummary {
  const latestToolSequence = getLatestToolSequence(groupedMessages);
  const latestToolCall =
    latestToolSequence?.pairedCalls[latestToolSequence.pairedCalls.length - 1] ?? null;

  const allMilestones = extractMilestones(groupedMessages);
  const recent = allMilestones.slice(-3).reverse();
  const latestMilestone = recent[0] ?? null;

  const { visibleFiles: filesTouched, hiddenFileCount } = extractFilesTouched(
    groupedMessages,
    toolProgress
  );

  const latestThinkingSnippet = toThinkingSnippet(latestThinking);
  const needsAttention = buildNeedsAttention(pendingRequest, latestToolCall);
  const now = buildNowState({
    pendingRequest,
    latestToolCall,
    running,
    starting,
    stopping,
    permissionMode,
    latestThinkingSnippet,
    latestMilestone,
  });

  return {
    latestThinkingSnippet,
    now,
    recent,
    filesTouched,
    hiddenFileCount,
    needsAttention,
    latestToolSequence,
    latestToolCall,
  };
}
