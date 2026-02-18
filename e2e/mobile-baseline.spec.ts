import { expect, test } from '@playwright/test';

const mobileViewports = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-14', width: 390, height: 844 },
  { name: 'pixel-7', width: 412, height: 915 },
];

for (const viewport of mobileViewports) {
  test(`mobile baseline layout - ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/__mobile-baseline');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Mobile Baseline' })).toBeVisible();

    const firstReview = page.getByRole('button', {
      name: /Fix mobile workspace sheet interactions/i,
    });
    await firstReview.click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.keyboard.press('Escape');

    const chatDemo = page.getByTestId('mobile-chat-demo');
    await chatDemo.scrollIntoViewIfNeeded();
    await expect(chatDemo).toBeVisible();

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    const composer = page.getByTestId('mobile-chat-composer');
    await expect(composer).toBeVisible();
    const composerBefore = await composer.boundingBox();
    expect(composerBefore).not.toBeNull();

    await page.getByTestId('mobile-chat-messages').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    const composerAfter = await composer.boundingBox();
    expect(composerAfter).not.toBeNull();
    if (composerBefore && composerAfter) {
      expect(composerAfter.y + composerAfter.height).toBeLessThanOrEqual(viewport.height);
      expect(Math.abs(composerAfter.y - composerBefore.y)).toBeLessThanOrEqual(1);
    }

    await expect(page).toHaveScreenshot(`mobile-baseline-${viewport.name}.png`, {
      fullPage: true,
    });
  });
}
