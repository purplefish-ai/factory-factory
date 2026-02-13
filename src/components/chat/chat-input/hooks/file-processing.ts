import type { MessageAttachment } from '@/lib/chat-protocol';
import { fileToAttachment } from '@/lib/image-utils';

/**
 * Result of processing a single file.
 */
export interface ProcessFileResult {
  attachment?: MessageAttachment;
  error?: {
    fileName: string;
    message: string;
  };
}

/**
 * Result of processing multiple files.
 */
export interface ProcessFilesResult {
  attachments: MessageAttachment[];
  errors: Array<{ fileName: string; message: string }>;
}

/**
 * Process a single file into an attachment.
 * Returns either a successful attachment or an error.
 */
export async function processFile(file: File): Promise<ProcessFileResult> {
  try {
    const attachment = await fileToAttachment(file);
    return { attachment };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      error: {
        fileName: file.name,
        message,
      },
    };
  }
}

/**
 * Process multiple files into attachments.
 * Returns successful attachments and errors separately.
 */
export async function processFiles(files: File[]): Promise<ProcessFilesResult> {
  const results = await Promise.all(files.map((file) => processFile(file)));

  const attachments: MessageAttachment[] = [];
  const errors: Array<{ fileName: string; message: string }> = [];

  for (const result of results) {
    if (result.attachment) {
      attachments.push(result.attachment);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { attachments, errors };
}
