import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import * as imageUtils from '@/lib/image-utils';
import { processFile, processFiles } from './file-processing';

// Mock the fileToAttachment function
vi.mock('@/lib/image-utils', () => ({
  fileToAttachment: vi.fn(),
}));

describe('file-processing', () => {
  describe('processFile', () => {
    it('should successfully process a valid file', async () => {
      const mockFile = new File(['content'], 'test.png', { type: 'image/png' });
      const mockAttachment: MessageAttachment = {
        id: 'att-123',
        name: 'test.png',
        type: 'image/png',
        size: 7,
        data: 'base64data',
        contentType: 'image',
      };

      vi.mocked(imageUtils.fileToAttachment).mockResolvedValue(mockAttachment);

      const result = await processFile(mockFile);

      expect(result.attachment).toEqual(mockAttachment);
      expect(result.error).toBeUndefined();
      expect(imageUtils.fileToAttachment).toHaveBeenCalledWith(mockFile);
    });

    it('should return error for invalid file type', async () => {
      const mockFile = new File(['content'], 'test.txt', { type: 'text/plain' });
      const errorMessage = 'Unsupported file type: text/plain';

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue(new Error(errorMessage));

      const result = await processFile(mockFile);

      expect(result.attachment).toBeUndefined();
      expect(result.error).toEqual({
        fileName: 'test.txt',
        message: errorMessage,
      });
    });

    it('should return error for file size exceeding limit', async () => {
      const mockFile = new File(['x'.repeat(11 * 1024 * 1024)], 'large.png', {
        type: 'image/png',
      });
      const errorMessage = 'File too large: 11.0 MB (max 10.0 MB)';

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue(new Error(errorMessage));

      const result = await processFile(mockFile);

      expect(result.attachment).toBeUndefined();
      expect(result.error).toEqual({
        fileName: 'large.png',
        message: errorMessage,
      });
    });

    it('should handle non-Error exceptions', async () => {
      const mockFile = new File(['content'], 'test.png', { type: 'image/png' });

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue('String error');

      const result = await processFile(mockFile);

      expect(result.attachment).toBeUndefined();
      expect(result.error).toEqual({
        fileName: 'test.png',
        message: 'Unknown error',
      });
    });
  });

  describe('processFiles', () => {
    it('should process multiple valid files successfully', async () => {
      const mockFile1 = new File(['content1'], 'test1.png', { type: 'image/png' });
      const mockFile2 = new File(['content2'], 'test2.jpg', { type: 'image/jpeg' });

      const mockAttachment1: MessageAttachment = {
        id: 'att-1',
        name: 'test1.png',
        type: 'image/png',
        size: 8,
        data: 'base64data1',
        contentType: 'image',
      };

      const mockAttachment2: MessageAttachment = {
        id: 'att-2',
        name: 'test2.jpg',
        type: 'image/jpeg',
        size: 8,
        data: 'base64data2',
        contentType: 'image',
      };

      vi.mocked(imageUtils.fileToAttachment)
        .mockResolvedValueOnce(mockAttachment1)
        .mockResolvedValueOnce(mockAttachment2);

      const result = await processFiles([mockFile1, mockFile2]);

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments).toContain(mockAttachment1);
      expect(result.attachments).toContain(mockAttachment2);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle mixed success and failure results', async () => {
      const validFile = new File(['content'], 'valid.png', { type: 'image/png' });
      const invalidFile = new File(['content'], 'invalid.txt', { type: 'text/plain' });

      const mockAttachment: MessageAttachment = {
        id: 'att-1',
        name: 'valid.png',
        type: 'image/png',
        size: 7,
        data: 'base64data',
        contentType: 'image',
      };

      vi.mocked(imageUtils.fileToAttachment)
        .mockResolvedValueOnce(mockAttachment)
        .mockRejectedValueOnce(new Error('Unsupported file type: text/plain'));

      const result = await processFiles([validFile, invalidFile]);

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toEqual(mockAttachment);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        fileName: 'invalid.txt',
        message: 'Unsupported file type: text/plain',
      });
    });

    it('should return empty arrays for empty input', async () => {
      const result = await processFiles([]);

      expect(result.attachments).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle all files failing', async () => {
      const file1 = new File(['content'], 'bad1.txt', { type: 'text/plain' });
      const file2 = new File(['content'], 'bad2.exe', { type: 'application/exe' });

      vi.mocked(imageUtils.fileToAttachment)
        .mockRejectedValueOnce(new Error('Unsupported file type: text/plain'))
        .mockRejectedValueOnce(new Error('Unsupported file type: application/exe'));

      const result = await processFiles([file1, file2]);

      expect(result.attachments).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toEqual({
        fileName: 'bad1.txt',
        message: 'Unsupported file type: text/plain',
      });
      expect(result.errors[1]).toEqual({
        fileName: 'bad2.exe',
        message: 'Unsupported file type: application/exe',
      });
    });
  });
});
