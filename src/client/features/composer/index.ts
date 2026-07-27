// The prompt composer: attachments, file mentions and slash commands.
//
// This is the shared half of what used to live inside chat's ChatInput. It has
// two consumers -- chat's own composer and kanban's inline workspace form --
// and nothing in here knows about a chat session, which is why it could be
// lifted out whole rather than exported piecemeal through chat's barrel.

// Components
export { AttachmentPreview } from './attachment-preview';
export { AttachmentViewerDialog } from './attachment-viewer-dialog';
export type {
  FileMentionKeyResult,
  FileMentionPaletteHandle,
  FileMentionPaletteProps,
} from './file-mention-palette';
export { FileMentionPalette } from './file-mention-palette';
export type {
  AttachmentCollectionResult,
  AttachmentConversionError,
} from './hooks/attachment-file-conversion';
// Hooks
export { collectAttachments, convertFileToAttachment } from './hooks/attachment-file-conversion';
export { usePasteDropHandler } from './hooks/use-paste-drop-handler';
export { useProjectFileMentions } from './hooks/use-project-file-mentions';
export { useSlashCommands } from './hooks/use-slash-commands';
export type { PaletteKeyboardHandle, PaletteKeyResult } from './palette-keyboard-navigation';
export { usePaletteKeyboardNavigation } from './palette-keyboard-navigation';
export type {
  SlashCommandPaletteHandle,
  SlashCommandPaletteProps,
  SlashKeyResult,
} from './slash-command-palette';
export { SlashCommandPalette } from './slash-command-palette';
