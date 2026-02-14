import { handleToolInputUpdate } from '@/components/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceToolingSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'TOOL_INPUT_UPDATE':
      return handleToolInputUpdate(state, action.payload.toolUseId, action.payload.input);
    case 'TOOL_USE_INDEXED': {
      const newToolUseIdToIndex = new Map(state.toolUseIdToIndex);
      newToolUseIdToIndex.set(action.payload.toolUseId, action.payload.index);
      return { ...state, toolUseIdToIndex: newToolUseIdToIndex };
    }
    case 'SDK_TOOL_PROGRESS': {
      const { toolUseId, toolName, elapsedSeconds, acpLocations, acpKind } = action.payload;
      const newToolProgress = new Map(state.toolProgress);
      newToolProgress.set(toolUseId, {
        toolName,
        elapsedSeconds,
        ...(acpLocations && { acpLocations }),
        ...(acpKind && { acpKind }),
      });
      return { ...state, toolProgress: newToolProgress };
    }
    case 'SDK_TOOL_USE_SUMMARY': {
      const { precedingToolUseIds } = action.payload;
      const newToolProgress = new Map(state.toolProgress);
      for (const toolUseId of precedingToolUseIds) {
        newToolProgress.delete(toolUseId);
      }
      return { ...state, toolProgress: newToolProgress };
    }
    case 'SDK_COMPACTING_START':
      return { ...state, isCompacting: true };
    case 'SDK_COMPACTING_END':
      return { ...state, isCompacting: false };
    case 'ACP_PLAN_UPDATE':
      return {
        ...state,
        acpPlan: {
          entries: action.payload.entries,
          updatedAt: new Date().toISOString(),
        },
      };
    default:
      return state;
  }
}
