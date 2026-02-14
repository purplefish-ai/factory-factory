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
  /** ACP option IDs mapped to answer labels for submitting the user's choice. */
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
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
  /** ACP permission options for multi-option UI. When present, frontend renders option buttons. */
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
}
