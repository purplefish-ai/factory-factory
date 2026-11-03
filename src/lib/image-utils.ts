import type { MessageAttachment } from './chat-protocol';

export { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';

/**
 * Supported image MIME types for upload.
 * Note: 'image/jpg' is included for compatibility with some non-standard sources,
 * though the standard MIME type is 'image/jpeg'.
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
] as const;

/**
 * Supported text file extensions for drag-and-drop.
 */
export const SUPPORTED_TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.log',
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.css',
  '.yaml',
  '.yml',
  '.xml',
  '.sh',
] as const;

/**
 * Maximum file size for text file uploads (1MB).
 */
export const MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024;

/**
 * Generate a unique ID for an attachment.
 */
export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if a file is a supported image type.
 */
export function isSupportedImageType(type: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(type as (typeof SUPPORTED_IMAGE_TYPES)[number]);
}

/**
 * Check if a filename has a supported text file extension.
 */
export function isSupportedTextFile(filename: string): boolean {
  const lowerName = filename.toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

/**
 * Convert a File to a base64 encoded string.
 * Reads the file as a data URL and strips the prefix (e.g., "data:image/png;base64,"),
 * returning only the base64-encoded payload.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1] as string;
      resolve(base64);
    };
    reader.onerror = () => {
      const errorMessage = reader.error?.message || 'Unknown file read error';
      reject(new Error(`Failed to read file: ${errorMessage}`));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Read a text file and return its content.
 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => {
      const errorMessage = reader.error?.message || 'Unknown file read error';
      reject(new Error(`Failed to read file: ${errorMessage}`));
    };
    reader.readAsText(file);
  });
}

/**
 * Format line count for display.
 */
export function formatLineCount(text: string): string {
  const lines = text.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

/**
 * Check if an attachment is a text attachment.
 */
export function isTextAttachment(attachment: MessageAttachment): boolean {
  return attachment.contentType === 'text';
}
