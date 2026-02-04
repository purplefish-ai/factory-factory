import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/claude-types';
import * as imageUtils from '@/lib/image-utils';
import { processFile, processFiles } from './file-processing';

// Mock the image-utils module
vi.mock('@/lib/image-utils', () => ({
  fileToAttachment: vi.fn(),
}));

describe('file-processing', () => {
  describe('processFile', () => {
    it('should successfully process a valid file', async () => {
      const mockFile = new File(['content'], 'test.png', { type: 'image/png' });
      const mockAttachment: MessageAttachment = {
        id: 'test-id',
        name: 'test.png',
        type: 'image/png',
        size: 7,
        data: 'base64data',
        contentType: 'image',
      };

      vi.mocked(imageUtils.fileToAttachment).mockResolvedValue(mockAttachment);

      const result = await processFile(mockFile);

      expect(result).toEqual({
        success: true,
        attachment: mockAttachment,
        fileName: 'test.png',
      });
      expect(imageUtils.fileToAttachment).toHaveBeenCalledWith(mockFile);
    });

    it('should handle file processing errors with Error instance', async () => {
      const mockFile = new File(['content'], 'invalid.txt', { type: 'text/plain' });

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue(
        new Error('Unsupported file type: text/plain')
      );

      const result = await processFile(mockFile);

      expect(result).toEqual({
        success: false,
        error: 'Unsupported file type: text/plain',
        fileName: 'invalid.txt',
      });
    });

    it('should handle non-Error exceptions', async () => {
      const mockFile = new File(['content'], 'test.png', { type: 'image/png' });

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue('String error');

      const result = await processFile(mockFile);

      expect(result).toEqual({
        success: false,
        error: 'Unknown error',
        fileName: 'test.png',
      });
    });

    it('should handle file size limit errors', async () => {
      const mockFile = new File(['x'.repeat(11 * 1024 * 1024)], 'large.png', {
        type: 'image/png',
      });

      vi.mocked(imageUtils.fileToAttachment).mockRejectedValue(
        new Error('File too large: 11.0 MB (max 10.0 MB)')
      );

      const result = await processFile(mockFile);

      expect(result).toEqual({
        success: false,
        error: 'File too large: 11.0 MB (max 10.0 MB)',
        fileName: 'large.png',
      });
    });
  });

  describe('processFiles', () => {
    it('should process multiple files successfully', async () => {
      const mockFile1 = new File(['content1'], 'test1.png', { type: 'image/png' });
      const mockFile2 = new File(['content2'], 'test2.jpg', { type: 'image/jpeg' });

      const mockAttachment1: MessageAttachment = {
        id: 'test-id-1',
        name: 'test1.png',
        type: 'image/png',
        size: 8,
        data: 'base64data1',
        contentType: 'image',
      };

      const mockAttachment2: MessageAttachment = {
        id: 'test-id-2',
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
      expect(result.attachments).toEqual([mockAttachment1, mockAttachment2]);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle mixed success and failure', async () => {
      const mockFile1 = new File(['content1'], 'test1.png', { type: 'image/png' });
      const mockFile2 = new File(['content2'], 'invalid.txt', { type: 'text/plain' });
      const mockFile3 = new File(['content3'], 'test3.jpg', { type: 'image/jpeg' });

      const mockAttachment1: MessageAttachment = {
        id: 'test-id-1',
        name: 'test1.png',
        type: 'image/png',
        size: 8,
        data: 'base64data1',
        contentType: 'image',
      };

      const mockAttachment3: MessageAttachment = {
        id: 'test-id-3',
        name: 'test3.jpg',
        type: 'image/jpeg',
        size: 8,
        data: 'base64data3',
        contentType: 'image',
      };

      vi.mocked(imageUtils.fileToAttachment)
        .mockResolvedValueOnce(mockAttachment1)
        .mockRejectedValueOnce(new Error('Unsupported file type: text/plain'))
        .mockResolvedValueOnce(mockAttachment3);

      const result = await processFiles([mockFile1, mockFile2, mockFile3]);

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments).toEqual([mockAttachment1, mockAttachment3]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        fileName: 'invalid.txt',
        message: 'Unsupported file type: text/plain',
      });
    });

    it('should handle all files failing', async () => {
      const mockFile1 = new File(['content1'], 'invalid1.txt', { type: 'text/plain' });
      const mockFile2 = new File(['content2'], 'invalid2.doc', { type: 'application/msword' });

      vi.mocked(imageUtils.fileToAttachment)
        .mockRejectedValueOnce(new Error('Unsupported file type: text/plain'))
        .mockRejectedValueOnce(new Error('Unsupported file type: application/msword'));

      const result = await processFiles([mockFile1, mockFile2]);

      expect(result.attachments).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toEqual([
        { fileName: 'invalid1.txt', message: 'Unsupported file type: text/plain' },
        { fileName: 'invalid2.doc', message: 'Unsupported file type: application/msword' },
      ]);
    });

    it('should handle empty file array', async () => {
      const result = await processFiles([]);

      expect(result.attachments).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should process files in parallel', async () => {
      const mockFiles = Array.from(
        { length: 5 },
        (_, i) => new File([`content${i}`], `test${i}.png`, { type: 'image/png' })
      );

      const mockAttachments = mockFiles.map((file, i) => ({
        id: `test-id-${i}`,
        name: file.name,
        type: file.type,
        size: file.size,
        data: `base64data${i}`,
        contentType: 'image' as const,
      }));

      for (const attachment of mockAttachments) {
        vi.mocked(imageUtils.fileToAttachment).mockResolvedValueOnce(attachment);
      }

      const result = await processFiles(mockFiles);

      expect(result.attachments).toHaveLength(5);
      expect(result.errors).toHaveLength(0);
      // Verify all files were processed (fileToAttachment called for each)
      expect(imageUtils.fileToAttachment).toHaveBeenCalledTimes(5);
    });
  });
});
