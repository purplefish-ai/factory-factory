import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  fileToAttachment,
  isSupportedImageType,
  isSupportedTextFile,
  textFileToAttachment,
} from '@/lib/image-utils';

export interface AttachmentConversionError {
  fileName: string;
  message: string;
}

export interface AttachmentCollectionResult {
  attachments: MessageAttachment[];
  errors: AttachmentConversionError[];
}

export async function convertFileToAttachment(file: File): Promise<MessageAttachment> {
  if (isSupportedImageType(file.type)) {
    return await fileToAttachment(file);
  }

  if (isSupportedTextFile(file.name)) {
    return await textFileToAttachment(file);
  }

  throw new Error('unsupported file type');
}

export async function collectAttachments(
  files: readonly File[] | FileList
): Promise<AttachmentCollectionResult> {
  const attachments: MessageAttachment[] = [];
  const errors: AttachmentConversionError[] = [];

  for (const file of Array.from(files)) {
    try {
      attachments.push(await convertFileToAttachment(file));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push({
        fileName: file.name,
        message,
      });
    }
  }

  return { attachments, errors };
}
