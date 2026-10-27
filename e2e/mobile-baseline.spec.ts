import { expect, test } from '@playwright/test';
import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';

const fixture = initTRPC.create({ transformer: superjson });
const usageRouter = fixture.router({
  session: fixture.router({
    getProviderUsage: fixture.procedure.query(() => ({
      provider: 'CLAUDE',
      status: 'available',
      updatedAt: '2026-01-12T12:00:00.000Z',
      windows: [
        { id: 'five_hour', label: '5-hour window', usedPercent: 38, resetsAt: 1_768_233_600 },
      ],
    })),
  }),
});

const mobileViewports = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-14', width: 390, height: 844 },
  { name: 'pixel-7', width: 412, height: 915 },
];

for (const viewport of mobileViewports) {
  test(`mobile baseline layout - ${viewport.name}`, async ({ page }) => {
    // PR fixture timestamps are fixed; keep relative-age labels stable in screenshots.
    await page.clock.setFixedTime(new Date('2026-01-12T12:00:00.000Z'));
    await page.route('**/api/trpc/session.getProviderUsage*', async (route) => {
      const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req: new Request(route.request().url(), { headers: route.request().headers() }),
        router: usageRouter,
        createContext: () => ({}),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
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
    const controls = composer.getByTestId('chat-input-controls');
    await expect(controls).toBeVisible();

    const optionsTrigger = composer.getByTestId('chat-options-trigger');
    await expect(optionsTrigger).toBeVisible();
    await optionsTrigger.click();
    const optionsSheet = page.getByTestId('chat-options-sheet');
    await expect(optionsSheet).toBeVisible();
    await expect(optionsSheet.getByRole('heading', { name: 'Chat Options' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(optionsSheet).toBeHidden();

    const messageInput = composer.getByRole('textbox');
    await messageInput.fill('Keep this draft');
    await composer.getByRole('button', { name: /Usage: 3% context/ }).click();
    await expect(page.getByText('38% used')).toBeVisible();
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    await expect(messageInput).toHaveValue('Keep this draft');
    await page.keyboard.press('Escape');
    await messageInput.fill('');

    const composerBefore = await composer.boundingBox();
    expect(composerBefore).not.toBeNull();

    await page.getByTestId('mobile-chat-messages').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    const composerAfter = await composer.boundingBox();
    expect(composerAfter).not.toBeNull();
    const controlOverflow = await controls.evaluate(
      (element) => element.scrollWidth - element.clientWidth
    );
    expect(controlOverflow).toBeLessThanOrEqual(1);

    if (composerBefore && composerAfter) {
      expect(composerAfter.y + composerAfter.height).toBeLessThanOrEqual(viewport.height);
      expect(Math.abs(composerAfter.y - composerBefore.y)).toBeLessThanOrEqual(1);
    }

    await expect(page).toHaveScreenshot(`mobile-baseline-${viewport.name}.png`, {
      fullPage: true,
    });
  });
}
