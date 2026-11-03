import { expect, it } from 'vitest';
import { MAX_IMAGE_SIZE as SHARED_MAX_IMAGE_SIZE } from '@/shared/attachment-limits';
import { MAX_IMAGE_SIZE as CLIENT_MAX_IMAGE_SIZE } from './image-utils';

it('uses the shared client and server image-size policy', () => {
  expect(SHARED_MAX_IMAGE_SIZE).toBe(CLIENT_MAX_IMAGE_SIZE);
});
