const COMMAND_APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'execCommandApproval',
] as const;

const FILE_CHANGE_APPROVAL_METHODS = [
  'item/fileChange/requestApproval',
  'applyPatchApproval',
] as const;

const USER_INPUT_METHODS = ['item/tool/requestUserInput', 'tool/requestUserInput'] as const;

// Intentionally unsupported for now; translator returns UNSUPPORTED_OPERATION.
export const CODEX_DYNAMIC_TOOL_CALL_METHOD = 'item/tool/call';

const commandApprovalMethodSet = new Set<string>(COMMAND_APPROVAL_METHODS);
const fileChangeApprovalMethodSet = new Set<string>(FILE_CHANGE_APPROVAL_METHODS);
const userInputMethodSet = new Set<string>(USER_INPUT_METHODS);

export function isCodexCommandApprovalMethod(method: string): boolean {
  return commandApprovalMethodSet.has(method);
}

export function isCodexFileChangeApprovalMethod(method: string): boolean {
  return fileChangeApprovalMethodSet.has(method);
}

export function isCodexUserInputMethod(method: string): boolean {
  return userInputMethodSet.has(method);
}
