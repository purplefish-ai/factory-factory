import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import * as imageUtils from '@/lib/image-utils';
import { collectAttachments, convertFileToAttachment } from './attachment-file-conversion';

vi.mock('@/lib/image-utils', () => ({
  fileToAttachment: vi.fn(),
  isSupportedImageType: vi.fn(),
  isSupportedTextFile: vi.fn(),
  textFileToAttachment: vi.fn(),
}));

describe('attachment-file-conversion', () => {
  it('converts image files with fileToAttachment', async () => {
    const file = new File(['content'], 'screenshot.png', { type: 'image/png' });
    const expected: MessageAttachment = {
      id: 'att-1',
      name: 'screenshot.png',
      type: 'image/png',
      size: 7,
      data: 'base64',
      contentType: 'image',
    };

    vi.mocked(imageUtils.isSupportedImageType).mockReturnValue(true);
    vi.mocked(imageUtils.fileToAttachment).mockResolvedValue(expected);

    await expect(convertFileToAttachment(file)).resolves.toEqual(expected);
    expect(imageUtils.fileToAttachment).toHaveBeenCalledWith(file);
  });

  it('converts supported text files with textFileToAttachment', async () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    const expected: MessageAttachment = {
      id: 'att-2',
      name: 'notes.md',
      type: 'text/plain',
      size: 5,
      data: 'base64',
      contentType: 'text',
    };

    vi.mocked(imageUtils.isSupportedImageType).mockReturnValue(false);
    vi.mocked(imageUtils.isSupportedTextFile).mockReturnValue(true);
    vi.mocked(imageUtils.textFileToAttachment).mockResolvedValue(expected);

    await expect(convertFileToAttachment(file)).resolves.toEqual(expected);
    expect(imageUtils.textFileToAttachment).toHaveBeenCalledWith(file);
  });

  it('throws for unsupported files', async () => {
    const file = new File(['bin'], 'program.exe', { type: 'application/octet-stream' });

    vi.mocked(imageUtils.isSupportedImageType).mockReturnValue(false);
    vi.mocked(imageUtils.isSupportedTextFile).mockReturnValue(false);

    await expect(convertFileToAttachment(file)).rejects.toThrow('unsupported file type');
  });

  it('collects attachments and per-file errors', async () => {
    const imageFile = new File(['img'], 'shot.png', { type: 'image/png' });
    const textFile = new File(['notes'], 'readme.md', { type: 'text/markdown' });
    const unsupportedFile = new File(['bin'], 'archive.zip', { type: 'application/zip' });

    const imageAttachment: MessageAttachment = {
      id: 'att-image',
      name: 'shot.png',
      type: 'image/png',
      size: 3,
      data: 'base64',
      contentType: 'image',
    };
    const textAttachment: MessageAttachment = {
      id: 'att-text',
      name: 'readme.md',
      type: 'text/plain',
      size: 5,
      data: 'base64',
      contentType: 'text',
    };

    vi.mocked(imageUtils.isSupportedImageType).mockImplementation((type) => type === 'image/png');
    vi.mocked(imageUtils.isSupportedTextFile).mockImplementation((name) => name.endsWith('.md'));
    vi.mocked(imageUtils.fileToAttachment).mockResolvedValue(imageAttachment);
    vi.mocked(imageUtils.textFileToAttachment).mockResolvedValue(textAttachment);

    const result = await collectAttachments([imageFile, textFile, unsupportedFile]);

    expect(result.attachments).toEqual([imageAttachment, textAttachment]);
    expect(result.errors).toEqual([
      {
        fileName: 'archive.zip',
        message: 'unsupported file type',
      },
    ]);
  });
});
