import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceRewindPreviewSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'REWIND_PREVIEW_START':
      return {
        ...state,
        rewindPreview: {
          userMessageId: action.payload.userMessageId,
          requestNonce: action.payload.requestNonce,
          isLoading: true,
        },
      };
    case 'REWIND_PREVIEW_SUCCESS': {
      if (!state.rewindPreview) {
        return state;
      }
      if (
        action.payload.userMessageId &&
        action.payload.userMessageId !== state.rewindPreview.userMessageId
      ) {
        return state;
      }
      return {
        ...state,
        rewindPreview: {
          ...state.rewindPreview,
          isLoading: false,
          affectedFiles: action.payload.affectedFiles,
        },
      };
    }
    case 'REWIND_PREVIEW_ERROR': {
      if (!state.rewindPreview) {
        return state;
      }
      if (
        action.payload.requestNonce &&
        action.payload.requestNonce !== state.rewindPreview.requestNonce
      ) {
        return state;
      }
      if (
        action.payload.userMessageId &&
        action.payload.userMessageId !== state.rewindPreview.userMessageId
      ) {
        return state;
      }
      return {
        ...state,
        rewindPreview: {
          ...state.rewindPreview,
          isLoading: false,
          error: action.payload.error,
        },
      };
    }
    case 'REWIND_CANCEL':
      return { ...state, rewindPreview: null };
    default:
      return state;
  }
}

export function reduceRewindExecutionSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'REWIND_EXECUTING':
      return state.rewindPreview
        ? {
            ...state,
            rewindPreview: {
              ...state.rewindPreview,
              isLoading: true,
              isExecuting: true,
            },
          }
        : state;
    case 'REWIND_SUCCESS': {
      if (!state.rewindPreview) {
        return state;
      }
      if (
        action.payload.userMessageId &&
        action.payload.userMessageId !== state.rewindPreview.userMessageId
      ) {
        return state;
      }
      return { ...state, rewindPreview: null };
    }
    default:
      return state;
  }
}
