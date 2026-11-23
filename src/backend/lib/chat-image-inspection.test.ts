import { describe, expect, it } from 'vitest';
import { gifHeader, jpegHeader, noisePng, webpHeader } from '@/test-utils/image-fixtures';
import { inspectChatImage } from './chat-image-inspection';

const b64 = (bytes: Buffer) => bytes.toString('base64');

describe('inspectChatImage', () => {
  it('reads the media type, decoded size and dimensions of each raster type', () => {
    const png = noisePng(3, 2);
    expect(inspectChatImage(b64(png))).toEqual({
      mediaType: 'image/png',
      size: png.length,
      width: 3,
      height: 2,
    });
    expect(inspectChatImage(b64(gifHeader(640, 480)))).toMatchObject({
      mediaType: 'image/gif',
      width: 640,
      height: 480,
    });
    expect(inspectChatImage(b64(webpHeader(1920, 1080)))).toMatchObject({
      mediaType: 'image/webp',
      width: 1920,
      height: 1080,
    });
    expect(inspectChatImage(b64(jpegHeader(800, 600)))).toMatchObject({
      mediaType: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('leaves out JPEG dimensions when Exif may rotate them', () => {
    const inspected = inspectChatImage(b64(jpegHeader(800, 600, { exif: true })));
    expect(inspected).toMatchObject({ mediaType: 'image/jpeg' });
    expect(inspected).not.toHaveProperty('width');
    expect(inspected).not.toHaveProperty('height');
  });

  it('uses the bytes, not a declared type, and refuses anything that is not a supported raster', () => {
    expect(inspectChatImage(b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe(
      null
    );
    expect(inspectChatImage(b64(Buffer.from('<!doctype html><script>1</script>')))).toBe(null);
    expect(inspectChatImage('')).toBe(null);
    expect(inspectChatImage('not base64!')).toBe(null);
    expect(inspectChatImage(`${b64(noisePng(1, 1))}\n`)).toBe(null);
  });
});
