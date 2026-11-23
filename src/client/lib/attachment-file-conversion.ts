import type { MessageAttachment } from '@/lib/chat-protocol';
import { formatBytes } from '@/lib/formatters';
import {
  fileToBase64,
  generateAttachmentId,
  isSupportedImageType,
  isSupportedTextFile,
  MAX_IMAGE_SIZE,
  MAX_TEXT_FILE_SIZE,
  readTextFile,
} from '@/lib/image-utils';
import {
  DOWNSCALE_JPEG_QUALITY,
  DOWNSCALE_MAX_EDGE,
  downscaleOutputType,
  keepsOriginal,
  MAX_DOWNSCALE_INPUT_SIZE,
  nameForType,
} from './image-downscale-plan';
import { resizeImage } from './image-resize';

interface AttachmentConversionError {
  fileName: string;
  message: string;
}

interface AttachmentCollectionResult {
  attachments: MessageAttachment[];
  errors: AttachmentConversionError[];
}

type AttachmentBatch =
  | { mode: 'images-only' | 'images-and-text'; files: readonly File[] | FileList }
  | { mode: 'clipboard-images'; images: readonly { file: File | null; type: string }[] };

function validateSize(size: number, limit: number, label: string): void {
  if (size > limit) {
    throw new Error(
      `${label} too large: ${formatBytes(size, { precision: 1 })} (max ${formatBytes(limit, { precision: 1 })})`
    );
  }
}

interface UploadImage {
  blob: Blob;
  type: string;
  name: string;
}

/**
 * Shrinks an image whose longest edge exceeds the cap. Any failure, or a
 * result that is not smaller, keeps the original as it was before downscaling.
 */
async function downscaleForUpload(file: File, type: string, name: string): Promise<UploadImage> {
  const original = { blob: file, type, name };
  const outputType = downscaleOutputType(type);
  if (!outputType || file.size > MAX_DOWNSCALE_INPUT_SIZE) {
    return original;
  }
  let resized: Blob | null;
  try {
    resized = await resizeImage(file, {
      maxEdge: DOWNSCALE_MAX_EDGE,
      outputType,
      quality: DOWNSCALE_JPEG_QUALITY,
    });
  } catch {
    return original;
  }
  if (!resized || resized.type !== outputType || keepsOriginal(file.size, resized.size)) {
    return original;
  }
  return { blob: resized, type: outputType, name: nameForType(name, type, outputType) };
}

async function imageAttachment(
  file: File,
  type: string,
  clipboard = false
): Promise<MessageAttachment> {
  if (!isSupportedImageType(type)) {
    throw new Error(`Unsupported file type: ${type}`);
  }
  const name = clipboard
    ? file.name || `pasted-image-${Date.now()}.${type.split('/')[1]}`
    : file.name;
  const upload = await downscaleForUpload(file, type, name);
  // The limit applies to what is uploaded, so a large photo that shrinks under it is accepted.
  validateSize(upload.blob.size, MAX_IMAGE_SIZE, clipboard ? 'Image' : 'File');

  let data: string;
  try {
    data = await fileToBase64(upload.blob);
  } catch (error) {
    if (!clipboard) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Couldn't read image. ${message}`);
  }

  return {
    id: generateAttachmentId(),
    name: upload.name,
    type: upload.type,
    size: upload.blob.size,
    data,
    contentType: 'image',
  };
}

async function textAttachment(file: File): Promise<MessageAttachment> {
  validateSize(file.size, MAX_TEXT_FILE_SIZE, 'File');
  let data: string;
  try {
    data = await readTextFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Couldn't read ${file.name}. ${message}`);
  }
  return {
    id: generateAttachmentId(),
    name: file.name,
    type: file.type || 'text/plain',
    size: file.size,
    data,
    contentType: 'text',
  };
}

async function convertFile(file: File, mode: 'images-only' | 'images-and-text') {
  if (isSupportedImageType(file.type) || mode === 'images-only') {
    return await imageAttachment(file, file.type);
  }
  if (isSupportedTextFile(file.name)) {
    return await textAttachment(file);
  }
  throw new Error('unsupported file type');
}

/**
 * Owns file validation, attachment envelopes and ordered partial-success results.
 * Chat file selection reads images concurrently; mixed drops and clipboard images
 * retain their sequential reads. Clipboard callers must capture live items first.
 */
export async function collectAttachments(
  batch: AttachmentBatch
): Promise<AttachmentCollectionResult> {
  const inputs =
    batch.mode === 'clipboard-images'
      ? batch.images
      : Array.from(batch.files, (file) => ({ file, type: file.type }));
  const convert = async ({ file, type }: (typeof inputs)[number]) => {
    try {
      if (!file) {
        throw new Error(`Couldn't extract image from clipboard (${type})`);
      }
      const attachment =
        batch.mode === 'clipboard-images'
          ? await imageAttachment(file, type, true)
          : await convertFile(file, batch.mode);
      return { attachment };
    } catch (error) {
      return {
        error: {
          fileName: file?.name ?? '',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  };

  const results = [];
  if (batch.mode === 'images-only') {
    results.push(...(await Promise.all(inputs.map(convert))));
  } else {
    for (const input of inputs) {
      results.push(await convert(input));
    }
  }
  const attachments: MessageAttachment[] = [];
  const errors: AttachmentConversionError[] = [];
  for (const result of results) {
    if (result.attachment) {
      attachments.push(result.attachment);
    } else if (result.error) {
      errors.push(result.error);
    }
  }
  return { attachments, errors };
}
