/**
 * Option for AskUserQuestion.
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
}

/**
 * Question in AskUserQuestion input.
 */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * User question request for approval UI (Phase 11).
 */
export interface UserQuestionRequest {
  requestId: string;
  questions: AskUserQuestion[];
  timestamp: string;
}

/**
 * Permission request for approval UI (Phase 9).
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
  /** Plan content for ExitPlanMode requests (markdown) */
  planContent?: string | null;
}
