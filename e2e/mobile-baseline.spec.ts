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
    await expect(chatDemo).toHaveAttribute('data-sent-commands', '["/compact"]');
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

for (const viewport of mobileViewports) {
  test(`Agents mobile shell - ${viewport.name}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-12T12:00:00.000Z'));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/__mobile-baseline?surface=agents');
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open Factory Factory workspaces', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle sidebar', exact: true })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Project sections', exact: true })
    ).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Open project menu', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Factory Factory', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Other project', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    const sidebar = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(sidebar).toBeVisible();
    const footer = sidebar.locator('[data-sidebar="footer"]');
    await expect(footer.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute(
      'href',
      '/projects/factory-factory/agents'
    );
    await expect(footer.getByRole('link', { name: /Reviews/ })).toHaveAttribute(
      'href',
      '/projects/factory-factory/reviews'
    );
    await expect(footer.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
      'href',
      '/admin'
    );
    expect(
      await footer
        .locator('a')
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute('aria-label') ?? link.textContent)
        )
    ).toEqual(['Agents', 'Reviews2', 'Settings']);
    await expect(
      footer.getByRole('link', { name: 'Agents', exact: true })
    ).toHaveAccessibleDescription('2 agents');
    await expect(footer.locator('[data-agent-count]')).toHaveText('2');
    await expect(page).toHaveScreenshot(`agents-sidebar-${viewport.name}.png`);
    await sidebar.getByRole('button', { name: 'Close sidebar', exact: true }).click();
    await expect(sidebar).toBeHidden();
    const rail = page.getByRole('navigation', { name: 'Agents', exact: true });
    await expect(rail).toBeVisible();
    const dependencies = rail.getByRole('link', { name: /Keep dependencies current/ });
    await dependencies.click();
    await expect(dependencies).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Keep dependencies current' })).toBeVisible();
    const review = rail.getByRole('link', { name: /Review recent changes/ });
    await review.focus();
    await page.keyboard.press('Enter');
    await expect(review).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Review recent changes' })).toBeVisible();
    const workspaceLink = page.getByRole('link', { name: /Open workspace/ });
    await workspaceLink.scrollIntoViewIfNeeded();
    await expect(workspaceLink).toHaveAttribute(
      'href',
      '/projects/factory-factory/workspaces/archived-run'
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    ).toBeLessThanOrEqual(1);
    await page.locator('main').evaluate((element) => {
      element.scrollTop = 0;
    });
    await review.blur();
    await expect(page).toHaveScreenshot(`agents-detail-${viewport.name}.png`);
    await workspaceLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/projects\/factory-factory\/workspaces\/archived-run$/);
    await page.goto('/__mobile-baseline?surface=agents');
    await page.getByRole('button', { name: 'Create Agent', exact: true }).click();
    await expect(rail).toBeVisible();
    const form = page.locator('form');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Review mobile layouts');
    await form
      .getByRole('textbox', { name: 'Instructions', exact: true })
      .fill('Check narrow layouts and open a focused pull request.');
    await form.getByRole('combobox', { name: 'Schedule', exact: true }).click();
    await page.getByRole('option', { name: 'Weekly', exact: true }).click();
    await form.getByLabel('Run time (optional)').fill('09:30');
    await expect(
      form.getByText('The first run starts shortly after creation, then follows this schedule.', {
        exact: false,
      })
    ).toBeVisible();
    await expect(form.getByRole('button', { name: 'Create Agent', exact: true })).toBeEnabled();
    await form.getByRole('button', { name: 'Create Agent', exact: true }).scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    ).toBeLessThanOrEqual(1);
    await expect(page).toHaveScreenshot(`agents-create-${viewport.name}.png`);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review recent changes' })).toBeVisible();
  });
}

for (const width of [320, 375, 390, 412, 1280]) {
  test(`settings menu scrolls without widening the page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/__mobile-baseline?surface=settings');
    const tabs = page.getByRole('tablist');
    await expect(tabs).toBeVisible();
    // Check both document and page container: an ancestor can absorb overflow.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await tabs.evaluate((list) => list.closest('.overflow-y-auto')?.scrollWidth)).toBe(
      width
    );
    const scroller = tabs.locator('..');
    if (width < 500) {
      expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await scroller.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    const voiceTab = page.getByRole('tab', { name: 'Voice Mode' });
    await voiceTab.click();
    await expect(voiceTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveText('Voice settings content');
    await page.getByRole('tab', { name: 'General Settings' }).focus();
    await expect(page.getByRole('tab', { name: 'General Settings' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
