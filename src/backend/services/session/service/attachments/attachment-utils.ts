import type { MessageAttachment } from '@/shared/acp-protocol';

const PASTED_TEXT_NAME = /^Pasted text\b/i;
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

export function stripBase64LineEndings(data: string): string {
  return data.replace(/[\r\n]/g, '');
}

function looksLikeBase64(data: string): boolean {
  const normalizedData = stripBase64LineEndings(data);
  if (!normalizedData) {
    return false;
  }

  if (normalizedData !== data && normalizedData.length % 4 !== 0) {
    return false;
  }

  return BASE64_REGEX.test(normalizedData);
}

function isNameLikelyText(name: string): boolean {
  return PASTED_TEXT_NAME.test(name);
}

type AttachmentLike = Pick<MessageAttachment, 'name' | 'type' | 'data' | 'contentType'>;

export function resolveAttachmentContentType(attachment: AttachmentLike): 'text' | 'image' {
  if (attachment.contentType === 'text' || attachment.contentType === 'image') {
    return attachment.contentType;
  }

  if (attachment.type?.startsWith('text/')) {
    return 'text';
  }

  if (attachment.type?.startsWith('image/')) {
    return 'image';
  }

  if (isNameLikelyText(attachment.name)) {
    return 'text';
  }

  if (!looksLikeBase64(attachment.data)) {
    return 'text';
  }

  return 'image';
}
