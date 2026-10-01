import { expect, type Locator, test } from '@playwright/test';

async function expectReachableAboveComposer(button: Locator, composer: Locator) {
  await expect(button).toBeVisible();
  await expect
    .poll(async () => {
      const buttonBox = await button.boundingBox();
      const composerBox = await composer.boundingBox();
      if (!(buttonBox && composerBox)) {
        return false;
      }
      return buttonBox.y + buttonBox.height <= composerBox.y;
    })
    .toBe(true);
  expect(
    await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      );
    })
  ).toBe(true);
}

for (const viewport of [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
  { width: 1024, height: 768 },
]) {
  test(`scroll button remains reachable during composer height changes at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // The Storybook surface uses mock messages and local callbacks only. Supply
    // the read-only voice configuration locally, with no backend connection.
    await page.route('**/api/trpc/**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          { result: { data: { json: { enabled: false, hasApiKey: false } } } },
        ]),
      })
    );
    await page.goto(
      '/iframe.html?id=workspaces-chatcontent--composer-height-changes&viewMode=story'
    );
    const chat = page.getByTestId('mock-conversation');
    const input = chat.getByPlaceholder('Type a message...');
    await expect(input).toBeVisible();
    const messageViewport = chat.locator('.overflow-y-auto').first();
    const composer = chat.locator('.border-t.bg-background').first();
    const button = chat.getByRole('button', { name: 'Scroll to bottom' });

    await messageViewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(button).toBeHidden();
    await messageViewport.hover();
    await page.mouse.wheel(0, -10_000);
    await expect(button).toBeVisible();
    const initialHeight = await composer.evaluate(
      (element) => element.getBoundingClientRect().height
    );

    const draft = Array.from({ length: 8 }, (_, index) => `Local draft line ${index + 1}`).join(
      '\n'
    );
    await input.fill(draft);
    await expect
      .poll(async () => composer.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(128);
    await expectReachableAboveComposer(button, composer);
    await expect.poll(async () => messageViewport.evaluate((element) => element.scrollTop)).toBe(0);
    await page.screenshot({ path: test.info().outputPath('tall-composer.png') });

    await page.getByRole('button', { name: 'Add mock attachment' }).click();
    await expect(chat.getByText('Local notes.txt')).toBeVisible();
    await expectReachableAboveComposer(button, composer);

    await page.getByRole('button', { name: 'Show plan', exact: true }).click();
    await expect(chat.getByLabel('Plan approval request')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Collapse', exact: true })).toBeVisible();
    await expectReachableAboveComposer(button, composer);
    await chat.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expectReachableAboveComposer(button, composer);
    await chat.getByRole('button', { name: 'Expand', exact: true }).click();
    await expectReachableAboveComposer(button, composer);
    await page.getByRole('button', { name: 'Clear prompt' }).click();
    await page.getByRole('button', { name: 'Show question' }).click();
    await expect(chat.getByText('Which local layout should we check?')).toBeVisible();
    await expectReachableAboveComposer(button, composer);
    const send = chat.getByRole('button', { name: 'Send message' });
    await expect(send).toBeEnabled();
    expect(
      await send.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.bottom <= window.innerHeight &&
          element.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          )
        );
      })
    ).toBe(true);
    await page.getByRole('button', { name: 'Clear prompt' }).click();

    await button.click();
    await expect(button).toBeHidden();
    await expect
      .poll(() =>
        messageViewport.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(1);
    await expect(input).toHaveValue(draft);

    await messageViewport.hover();
    await page.mouse.wheel(0, -10_000);
    await expect(button).toBeVisible();
    await page.getByRole('button', { name: 'Clear attachments' }).click();
    await input.fill('');
    await expect
      .poll(async () => composer.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(initialHeight);
    await expectReachableAboveComposer(button, composer);
    expect(
      await chat.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1);

    // Scroll back down naturally as well as through the CTA.
    await messageViewport.hover();
    await page.mouse.wheel(0, 10_000);
    await expect(button).toBeHidden();
  });
}
