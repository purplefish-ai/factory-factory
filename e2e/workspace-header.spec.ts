import { expect, test, type Page } from '@playwright/test';

// Headless Chromium has no installed OS window. Emulate only the browser-owned
// media query and env() geometry; keep the production declarations and UI intact.
function emulateTitleBar(page: Page, left: number, right: number) {
  return page.evaluate(
    ({ left, right }) => {
      const values: Record<string, string> = {
        'titlebar-area-x': `${left}px`,
        'titlebar-area-y': '0px',
        'titlebar-area-width': `${window.innerWidth - left - right}px`,
        'titlebar-area-height': '32px',
      };
      const rules = [...document.styleSheets]
        .filter((sheet) => !sheet.href || new URL(sheet.href).origin === location.origin)
        .flatMap((sheet) => [...sheet.cssRules]);
      const overlayRule = rules.find(
        (rule) =>
          rule instanceof CSSMediaRule &&
          rule.conditionText === '(display-mode: window-controls-overlay)'
      );
      if (!(overlayRule instanceof CSSMediaRule)) {
        return false;
      }
      overlayRule.media.mediaText = 'all';
      for (const child of overlayRule.cssRules) {
        if (!(child instanceof CSSStyleRule)) {
          continue;
        }
        for (const property of [...child.style]) {
          const value = child.style.getPropertyValue(property);
          child.style.setProperty(
            property,
            value.replace(
              /env\((titlebar-area-[\w-]+)(?:,[^)]*)?\)/g,
              (match, name: string) => values[name] ?? match
            )
          );
        }
      }
      return true;
    },
    { left, right }
  );
}

for (const { platform, left, right } of [
  { platform: 'macOS', left: 86, right: 40 },
  { platform: 'Windows', left: 0, right: 140 },
]) {
  test(`installed PWA header fits beside ${platform} controls and stays interactive`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto('/__mobile-baseline?surface=header');
    const header = page.locator('header');
    await expect(header).toHaveCSS('padding-left', '8px');
    await expect(header).toHaveCSS('-webkit-app-region', 'none');
    expect(await emulateTitleBar(page, left, right)).toBe(true);
    await expectOneRow(page);
    await expect(header).toHaveCSS('-webkit-app-region', 'drag');
    const controls = header.locator('button, a, [role="combobox"]:not(button)');
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) {
        continue;
      }
      const box = await control.boundingBox();
      if (!box) {
        throw new Error('Visible header control has no bounding box');
      }
      expect(box.x).toBeGreaterThanOrEqual(left);
      expect(box.x + box.width).toBeLessThanOrEqual(1100 - right);
      await expect(control).toHaveCSS('-webkit-app-region', 'no-drag');
    }
    await page.getByRole('combobox', { name: 'Open project menu' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

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
  test(`workspace family navigation fits and opens at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/__mobile-baseline?surface=header&header=family');
    const parent = page.getByRole('link', {
      name: 'Parent workspace: Authentication refactor across several projects',
    });
    await expect(parent).toBeVisible();
    await expect(parent).toHaveAttribute('href', '/projects/api/workspaces/family-parent');
    expect(
      await page
        .locator('.workspace-switcher-label')
        .evaluate((label) => label.getBoundingClientRect().width)
    ).toBeGreaterThan(24);
    await expectOneRow(page);
    await page.getByRole('button', { name: 'Navigate workspace family' }).click();
    await expect(page.getByRole('menu')).toContainText('Waiting');
    await expect(page.getByRole('menu')).toContainText('Working');
    await expect(page.getByRole('menu').locator('[aria-current="page"]')).toBeVisible();
  });
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

for (const width of [375, 810]) {
  for (const variant of ['workspace', 'project']) {
    test(`${variant} project retry keeps one row at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(`/__mobile-baseline?surface=header&header=${variant}&projectsError=1`);
      await expect(page.getByRole('alert')).toContainText('Project refresh unavailable');
      await expectOneRow(page);
      const currentProject = page.getByRole('button', {
        name: 'Open Factory Factory with an exceptionally long project name workspaces',
        exact: true,
      });
      await expect(currentProject).toBeVisible();
      await expect(page.locator('header')).toHaveScreenshot(
        `${variant}-header-project-error-${width}.png`
      );
      await page.getByRole('combobox', { name: 'Open project menu' }).click();
      await expect(
        page.getByRole('option', {
          name: 'Factory Factory with an exceptionally long project name',
          exact: true,
        })
      ).toBeVisible();
      const retry = page.getByRole('option', { name: 'Retry projects', exact: true });
      await expect(retry).toBeVisible();
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Project retry count')).toHaveText('1');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(currentProject).toBeVisible();
      await expectOneRow(page);
      if (variant === 'workspace') {
        await page.getByRole('combobox', { name: /Open workspace menu/ }).click();
        await expect(page.getByText('Waiting · 0')).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await page.getByRole('combobox', { name: 'Open project menu' }).click();
      await expect(page.getByRole('option', { name: 'Retry projects', exact: true })).toHaveCount(
        0
      );
      await expect(
        page.getByRole('option', { name: '+ Create project', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('option', { name: 'Manage projects...', exact: true })
      ).toBeVisible();
    });
  }
}
