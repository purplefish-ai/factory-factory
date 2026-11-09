import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });
for (const { variant, width } of ['workspace', 'family'].flatMap((variant) =>
  [320, 375].map((width) => ({ variant, width }))
)) {
  test(`phone ${variant} header at ${width}px reserves readable workspace context and touch targets`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(`/__mobile-baseline?surface=header&header=${variant}`);
    const label = page.locator('.workspace-switcher-label');
    await expect(label).toBeVisible();
    expect((await label.boundingBox())?.width).toBeGreaterThanOrEqual(120);
    const controls = await page
      .locator('header')
      .locator('button, a, [role="combobox"]:not(button)')
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              label: element.getAttribute('aria-label'),
              x: box.x,
              right: box.right,
              y: box.y,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
          })
          .filter(({ width, height }) => width && height)
      );
    for (const [index, control] of controls.entries()) {
      expect(control.x, control.label ?? '').toBeGreaterThanOrEqual(0);
      expect(control.right, control.label ?? '').toBeLessThanOrEqual(width);
      for (const other of controls.slice(index + 1)) {
        const overlapX = Math.min(control.right, other.right) - Math.max(control.x, other.x);
        const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.y, other.y);
        expect(overlapX <= 1 || overlapY <= 1, `${control.label} overlaps ${other.label}`).toBe(
          true
        );
      }
    }
    for (const name of ['Search', 'Toggle sidebar', 'More actions']) {
      const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(bounds?.width, name).toBeGreaterThanOrEqual(36);
      expect(bounds?.height, name).toBeGreaterThanOrEqual(36);
    }
    if (variant === 'family') {
      await expect(page.getByRole('link', { name: /^Parent workspace:/ })).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath(`phone-${variant}.png`) });
    await page.getByRole('combobox', { name: /Open workspace menu/ }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
  });
}

test('phone Automations scrolls its rail and editor as one surface', async ({ page }) => {
  await page.goto('/__mobile-baseline?surface=agents');
  const shell = page.locator('[class~="@container/agents"]');
  await expect(shell.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible();
  const nestedPanes = await shell.locator('nav, main').evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const overflow = getComputedStyle(element).overflowY;
        return ['auto', 'scroll'].includes(overflow) && element.scrollHeight > element.clientHeight;
      }).length
  );
  expect(nestedPanes).toBe(0);
  const body = shell.locator(':scope > div').last();
  await page.getByRole('navigation', { name: 'Automations', exact: true }).hover();
  await page.mouse.wheel(0, 450);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
});

test('selecting from a long phone Automations rail reveals the editor', async ({ page }) => {
  await page.goto('/__mobile-baseline?surface=agents&many-agents');
  await page
    .getByRole('navigation', { name: 'Automations', exact: true })
    .getByRole('link', { name: /Keep dependencies current/ })
    .click();
  const editor = page.getByRole('main', { name: 'Automation details' });
  await expect(editor).toBeInViewport();
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('Keep dependencies current');
});

test('creating from a long phone Automations rail reveals the form and retains its input focus', async ({
  page,
}) => {
  await page.goto('/__mobile-baseline?surface=agents&many-agents');
  await page.getByRole('button', { name: 'Create automation', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Scheduled automation', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeInViewport();
  await expect(name).toBeFocused();
});

for (const width of [320, 360, 390]) {
  test(`thinking preview stays inside its reserved row on a ${width}px touch screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/__transcript-scroll?footer=1&composer=1');
    await page.getByRole('button', { name: 'Toggle activity', exact: true }).click();
    const footer = page.getByTestId('thinking-footer');
    const preview = footer.getByRole('button', { name: 'Show thinking preview' });
    await expect(preview).toBeVisible();
    const row = await footer.boundingBox();
    const button = await preview.boundingBox();
    if (!(row && button)) {
      throw new Error('Thinking row and preview must have bounds');
    }
    expect(button.y).toBeGreaterThanOrEqual(row.y);
    expect(button.y + button.height).toBeLessThanOrEqual(row.y + row.height);
    await preview.click();
    await expect(page.getByLabel('Thinking preview', { exact: true })).toBeVisible();
  });

  test(`running composer actions do not overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/__mobile-baseline?running=1');
    const controls = page.getByTestId('chat-input-controls');
    await controls.scrollIntoViewIfNeeded();
    await expect(controls.getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible();
    const boxes = await controls.locator('button').evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const { x, y, right, bottom, width, height } = button.getBoundingClientRect();
          return { x, y, right, bottom, width, height, label: button.getAttribute('aria-label') };
        })
        .filter((box) => box.width && box.height)
    );
    for (const [index, box] of boxes.entries()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      for (const other of boxes.slice(index + 1)) {
        expect(
          Math.min(box.right, other.right) - Math.max(box.x, other.x) <= 1 ||
            Math.min(box.bottom, other.bottom) - Math.max(box.y, other.y) <= 1,
          `${box.label} overlaps ${other.label}`
        ).toBe(true);
      }
    }
  });
}
