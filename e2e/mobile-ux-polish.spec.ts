import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });
for (const variant of ['workspace', 'family']) {
  test(`phone ${variant} header reserves readable workspace context and touch targets`, async ({
    page,
  }) => {
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
      expect(control.right, control.label ?? '').toBeLessThanOrEqual(375);
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
      expect(bounds?.width, name).toBeGreaterThanOrEqual(44);
      expect(bounds?.height, name).toBeGreaterThanOrEqual(44);
    }
    if (variant === 'family') {
      await expect(page.getByRole('link', { name: /^Parent workspace:/ })).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath(`phone-${variant}.png`) });
    await page.getByRole('combobox', { name: /Open workspace menu/ }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
  });
}

test('phone Agents scrolls its rail and editor as one surface', async ({ page }) => {
  await page.goto('/__mobile-baseline?surface=agents');
  const shell = page.locator('[class~="@container/agents"]');
  await expect(shell.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  const nestedPanes = await shell.locator('nav, main').evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const overflow = getComputedStyle(element).overflowY;
        return ['auto', 'scroll'].includes(overflow) && element.scrollHeight > element.clientHeight;
      }).length
  );
  expect(nestedPanes).toBe(0);
  const body = shell.locator(':scope > div').last();
  await page.getByRole('navigation', { name: 'Agents', exact: true }).hover();
  await page.mouse.wheel(0, 450);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
});

test('selecting from a long phone Agents rail reveals the editor', async ({ page }) => {
  await page.goto('/__mobile-baseline?surface=agents&many-agents');
  await page
    .getByRole('navigation', { name: 'Agents', exact: true })
    .getByRole('link', { name: /Keep dependencies current/ })
    .click();
  const editor = page.getByRole('main', { name: 'Agent details' });
  await expect(editor).toBeInViewport();
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('Keep dependencies current');
});

test('creating from a long phone Agents rail reveals the form and retains its input focus', async ({
  page,
}) => {
  await page.goto('/__mobile-baseline?surface=agents&many-agents');
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Scheduled agent', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeInViewport();
  await expect(name).toBeFocused();
});
