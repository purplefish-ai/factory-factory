declare module 'virtual:subagent-transcript-baseline' {
  export const baselineRevision: string;
  export const projectAcpTranscriptUpdates: typeof import('../src/client/features/chat/project-acp-transcript').projectAcpTranscriptUpdates;
}
