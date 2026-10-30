export type TranscriptIntent = 'following' | 'reading';

export interface TranscriptPosition {
  intent: TranscriptIntent;
  top: number;
  left: number;
  anchor?: { key: string; offset: number };
}

export interface TranscriptScrollOptions {
  identity: string;
  active: boolean;
  ready: boolean;
  initialIntent: TranscriptIntent;
  initialPosition: TranscriptPosition | null;
  onPositionChange?: (position: TranscriptPosition) => void;
}

export interface TranscriptScrollState {
  intent: TranscriptIntent;
  phase: 'suspended' | 'restoring' | 'ready';
}

export interface TranscriptScrollPort {
  cancelPositioning(): void;
  scrollToEnd(): void;
  capturePosition(intent: TranscriptIntent): TranscriptPosition;
  restorePosition(position: TranscriptPosition): { measured: boolean; reached: boolean };
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}
