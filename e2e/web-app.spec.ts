import { expect, test } from '@playwright/test';
import { z } from 'zod';

const manifestSchema = z.object({
  name: z.string().min(1),
  id: z.string(),
  start_url: z.string(),
  scope: z.string(),
  display: z.literal('standalone'),
  icons: z.array(z.object({ src: z.string(), sizes: z.string(), type: z.literal('image/png') })),
});

test('browser can discover a standalone app and decode its installation icons', async ({
  page,
}) => {
  await page.goto('/__mobile-baseline?surface=agents');
  const manifestUrl = await page.locator('link[rel="manifest"]').evaluate((link) => {
    if (!(link instanceof HTMLLinkElement)) {
      throw new Error('Expected a manifest link');
    }
    return link.href;
  });
  const response = await page.request.get(manifestUrl);
  expect(response.ok()).toBe(true);
  const manifest = manifestSchema.parse(await response.json());
  const origin = new URL(page.url()).origin;
  // Installation from any route must launch the app, rather than pinning that route.
  for (const path of [manifest.id, manifest.start_url, manifest.scope]) {
    expect(new URL(path, manifestUrl).href).toBe(`${origin}/`);
  }
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512'])
  );
  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').evaluate((link) => {
    if (!(link instanceof HTMLLinkElement)) {
      throw new Error('Expected an Apple icon link');
    }
    return link.href;
  });
  for (const icon of [...manifest.icons, { src: appleIcon, sizes: '180x180' }]) {
    const dimensions = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, new URL(icon.src, manifestUrl).href);
    expect(dimensions).toBe(icon.sizes);
  }
  const session = await page.context().newCDPSession(page);
  const parsed = await session.send('Page.getAppManifest');
  expect(parsed.errors).toEqual([]);
  expect(parsed.url).toBe(manifestUrl);
});
