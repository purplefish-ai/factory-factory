import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_SIZE as SHARED_MAX_IMAGE_SIZE } from '@/shared/attachment-limits';
import {
  fileToAttachment,
  textFileToAttachment,
  MAX_IMAGE_SIZE as CLIENT_MAX_IMAGE_SIZE,
} from './image-utils';

describe('image upload limits', () => {
  it('uses the shared client and server image-size policy', () => {
    expect(SHARED_MAX_IMAGE_SIZE).toBe(CLIENT_MAX_IMAGE_SIZE);
  });
});

it.each([
  ['image/png', 'huge.png', fileToAttachment, '10.0 MB'],
  ['text/plain', 'huge.txt', textFileToAttachment, '1.0 MB'],
])('keeps oversized %s errors readable in gigabytes', async (type, name, convert, limit) => {
  const file = new File([], name, { type });
  Object.defineProperty(file, 'size', { value: 1024 ** 3 });
  await expect(convert(file)).rejects.toThrow(`File too large: 1.0 GB (max ${limit})`);
});
