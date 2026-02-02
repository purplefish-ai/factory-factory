import type { MessageAttachment } from './claude-types';

/**
 * Supported image MIME types for upload.
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
 * Maximum file size for image uploads (10MB).
 */
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

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
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Convert a File to a MessageAttachment.
 */
export async function fileToAttachment(file: File): Promise<MessageAttachment> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB (max 10MB)`);
  }

  const base64 = await fileToBase64(file);

  return {
    id: generateAttachmentId(),
    name: file.name,
    type: file.type,
    size: file.size,
    data: base64,
    contentType: 'image',
  };
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read a text file and return its content.
 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Convert a text File to a MessageAttachment.
 */
export async function textFileToAttachment(file: File): Promise<MessageAttachment> {
  if (!isSupportedTextFile(file.name)) {
    throw new Error(`Unsupported text file type: ${file.name}`);
  }

  if (file.size > MAX_TEXT_FILE_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB (max 1MB)`);
  }

  const content = await readTextFile(file);

  return {
    id: generateAttachmentId(),
    name: file.name,
    type: file.type || 'text/plain',
    size: file.size,
    data: content, // raw text, not base64
    contentType: 'text',
  };
}
