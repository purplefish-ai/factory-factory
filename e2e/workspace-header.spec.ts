import { expect, test, type Page } from '@playwright/test';

async function expectOneRow(page: Page) {
  const geometry = await page.locator('header').evaluate((header) => {
    const controls = [...header.querySelectorAll('button, [role="combobox"], a')]
      .map((node) => ({
        label: node.getAttribute('aria-label') ?? node.textContent,
        rect: node.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.width && rect.height);
    const rect = header.getBoundingClientRect();
    return {
      height: rect.height,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      controls: controls.map(({ label, rect: box }) => ({
        label,
        x: box.x,
        y: box.y,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
      })),
      right: rect.right,
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(49);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  for (const [index, control] of geometry.controls.entries()) {
    expect(control.x, control.label ?? '').toBeGreaterThanOrEqual(0);
    expect(control.right, control.label ?? '').toBeLessThanOrEqual(geometry.right);
    expect(control.bottom, control.label ?? '').toBeLessThanOrEqual(48);
    for (const other of geometry.controls.slice(index + 1)) {
      expect(
        Math.min(control.right, other.right) - Math.max(control.x, other.x),
        `${control.label} overlaps ${other.label}`
      ).toBeLessThanOrEqual(1);
    }
  }
}
for (const width of [375, 768, 810, 1024, 1280]) {
  test(`workspace header keeps controls in one row at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/__mobile-baseline?surface=header');
    await expect(page.getByRole('button', { name: /Pull requests and updates/ })).toBeVisible();
    await expectOneRow(page);
    await expect(page.locator('header')).toHaveScreenshot(`workspace-header-${width}.png`);
    await page.getByRole('combobox', { name: 'Open project menu' }).click();
    await expect(
      page.getByRole('option', {
        name: 'Factory Factory with an exceptionally long project name',
        exact: true,
      })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: /Open workspace menu/ }).click();
    await expect(page.getByText('Waiting · 0')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Pull requests and updates/ }).click();
    await expect(page.getByRole('menuitem', { name: /Compact workspace header/ })).toBeVisible();
    await page.keyboard.press('Escape');
    if (width < 1152) {
      await page.getByRole('button', { name: 'More actions' }).click();
      for (const name of [
        'View details',
        'Rename workspace',
        'Provider settings',
        'Open in VS Code',
        'Open dev app',
        'Open branch on GitHub',
        'Create PR',
        '#3456',
        'Archive workspace',
      ]) {
        await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
      }
      await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Workspace details', exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('dialog', { name: 'Workspace details', exact: true })
      ).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu', { name: 'More actions' })).toBeHidden();
    }
    if (width === 810) {
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Rename workspace', exact: true }).focus();
      await page.keyboard.press('Enter');
      const rename = page.getByRole('dialog', { name: 'Rename workspace', exact: true });
      await expect(rename.getByRole('textbox')).toHaveValue(
        'A deliberately long workspace title for responsive header regression coverage'
      );
      await rename.getByRole('textbox').fill('Unsaved fixture name');
      await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(rename).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Provider settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Session Provider Defaults', exact: true });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(settings).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
    }
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
  });
  for (const variant of ['generic', 'project']) {
    test(`${variant} header keeps context at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(`/__mobile-baseline?surface=header&header=${variant}`);
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
      await expectOneRow(page);
      await expect(page.locator('header')).toHaveScreenshot(`${variant}-header-${width}.png`);
    });
  }
}
