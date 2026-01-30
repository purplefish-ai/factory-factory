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
 * Maximum file size for image uploads (10MB).
 */
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

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
