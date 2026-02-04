import type { MessageAttachment } from '@/lib/claude-types';
import { fileToAttachment } from '@/lib/image-utils';

/**
 * Result of processing a single file.
 */
export interface FileProcessingResult {
  success: boolean;
  attachment?: MessageAttachment;
  error?: string;
  fileName: string;
}

/**
 * Processes a single file and converts it to a MessageAttachment.
 * Returns a result object with success/error information.
 */
export async function processFile(file: File): Promise<FileProcessingResult> {
  try {
    const attachment = await fileToAttachment(file);
    return {
      success: true,
      attachment,
      fileName: file.name,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: message,
      fileName: file.name,
    };
  }
}

/**
 * Processes multiple files in parallel and returns successful attachments
 * along with any errors encountered.
 */
export async function processFiles(files: File[]): Promise<{
  attachments: MessageAttachment[];
  errors: Array<{ fileName: string; message: string }>;
}> {
  const results = await Promise.all(files.map(processFile));

  const attachments: MessageAttachment[] = [];
  const errors: Array<{ fileName: string; message: string }> = [];

  for (const result of results) {
    if (result.success && result.attachment) {
      attachments.push(result.attachment);
    } else if (result.error) {
      errors.push({ fileName: result.fileName, message: result.error });
    }
  }

  return { attachments, errors };
}
