import { createContext } from 'react';

/** Workspace identity for local image queries, including replayed transcripts. */
export const ChatImageWorkspaceContext = createContext<string | undefined>(undefined);
