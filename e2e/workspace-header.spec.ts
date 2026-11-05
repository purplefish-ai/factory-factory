import { expect, test, type Page } from '@playwright/test';

// Headless Chromium has no installed OS window. Emulate only the browser-owned
// media query and env() geometry; keep the production declarations and UI intact.
function emulateTitleBar(page: Page, left: number, right: number, height = 32, top = 0) {
  return page.evaluate(
    ({ left, right, height, top }) => {
      const values: Record<string, string> = {
        'titlebar-area-x': `${left}px`,
        'titlebar-area-y': `${top}px`,
        'titlebar-area-width': `calc(100% - ${left + right}px)`,
        'titlebar-area-height': `${height}px`,
      };
      const rules = [...document.styleSheets]
        .filter((sheet) => !sheet.href || new URL(sheet.href).origin === location.origin)
        .flatMap((sheet) => [...sheet.cssRules]);
      const overlayRules = rules.filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule &&
          rule.conditionText === '(display-mode: window-controls-overlay)'
      );
      if (!overlayRules.length) {
        return false;
      }
      const replaceGeometry = (child: CSSRule) => {
        if (!(child instanceof CSSStyleRule)) {
          return;
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
      };
      for (const overlayRule of overlayRules) {
        overlayRule.media.mediaText = 'all';
        [...overlayRule.cssRules].forEach(replaceGeometry);
      }
      return true;
    },
    { left, right, height, top }
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
    await expect(header).toBeVisible({ timeout: 15_000 });
    await expect(header).toHaveCSS('padding-left', '8px');
    await expect(header).toHaveCSS('-webkit-app-region', 'none');
    expect(await emulateTitleBar(page, left, right)).toBe(true);
    await expect(header).toHaveCSS('height', '33px');
    await expect(header).toHaveCSS('-webkit-app-region', 'drag');
    const controls = header.locator('button, a, [role="combobox"]:not(button)');
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) {
        continue;
      }
      // Overlay toggling changes sizes covered by the buttons' transition-all.
      await expect(control).toHaveCSS('height', '24px');
      const box = await control.boundingBox();
      if (!box) {
        throw new Error('Visible header control has no bounding box');
      }
      expect(box.x).toBeGreaterThanOrEqual(left);
      expect(box.x + box.width).toBeLessThanOrEqual(1100 - right);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeLessThanOrEqual(28);
      expect(
        Math.abs(box.y + box.height / 2 - 16),
        await control.getAttribute('aria-label')
      ).toBeLessThanOrEqual(0.5);
      await expect(control).toHaveCSS('-webkit-app-region', 'no-drag');
    }
    await expectHeaderFits(page, 33);
    await expect(header).toHaveScreenshot(`installed-pwa-header-${platform}.png`);
    await page.getByRole('button', { name: 'Open project menu' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

for (const scenario of [
  {
    variant: 'workspace',
    width: 810,
    left: 86,
    right: 40,
    scale: 100,
    height: 32,
    top: 0,
    row: 33,
  },
  { variant: 'family', width: 1100, left: 0, right: 140, scale: 150, height: 32, top: 0, row: 41 },
  {
    variant: 'workspace',
    width: 810,
    left: 86,
    right: 40,
    scale: 200,
    height: 32,
    top: 0,
    row: 53,
  },
  { variant: 'project', width: 768, left: 0, right: 140, scale: 100, height: 40, top: 6, row: 47 },
  { variant: 'generic', width: 640, left: 86, right: 40, scale: 150, height: 32, top: 0, row: 41 },
]) {
  test(`installed PWA ${scenario.variant} fits at ${scenario.width}px and ${scenario.scale}% font`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 720 });
    await page.goto(`/__mobile-baseline?surface=header&header=${scenario.variant}`);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await page.evaluate((scale) => {
      document.documentElement.style.fontSize = `${scale}%`;
      document.documentElement.classList.add('dark');
      document.documentElement.style.setProperty('--background', '#17111f');
      document.documentElement.style.setProperty('--foreground', '#e6d8f7');
    }, scenario.scale);
    expect(
      await emulateTitleBar(page, scenario.left, scenario.right, scenario.height, scenario.top)
    ).toBe(true);
    const header = page.locator('header');
    await expect(header).toHaveCSS('height', `${scenario.row}px`);
    const dividerTop = await header.evaluate((element) => {
      const border = Number.parseFloat(getComputedStyle(element).borderBottomWidth);
      return element.getBoundingClientRect().bottom - border;
    });
    expect(dividerTop).toBeGreaterThanOrEqual(scenario.top + scenario.height);
    await expectHeaderFits(page, scenario.row);
    for (const control of await header.locator('button, a').all()) {
      if (!(await control.isVisible())) {
        continue;
      }
      const box = await control.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(scenario.left);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        scenario.width - scenario.right
      );
      expect(box?.y).toBeGreaterThanOrEqual(scenario.top);
    }
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

async function expectHeaderFits(page: Page, maxHeight?: number) {
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
      phone: innerWidth < 768,
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
  expect(geometry.height).toBeLessThanOrEqual(maxHeight ?? (geometry.phone ? 97 : 49));
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  for (const [index, control] of geometry.controls.entries()) {
    expect(control.x, control.label ?? '').toBeGreaterThanOrEqual(0);
    expect(control.right, control.label ?? '').toBeLessThanOrEqual(geometry.right);
    expect(control.y, control.label ?? '').toBeGreaterThanOrEqual(0);
    expect(control.bottom, control.label ?? '').toBeLessThanOrEqual(geometry.height);
    for (const other of geometry.controls.slice(index + 1)) {
      const overlapX = Math.min(control.right, other.right) - Math.max(control.x, other.x);
      const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.y, other.y);
      expect(overlapX <= 1 || overlapY <= 1, `${control.label} overlaps ${other.label}`).toBe(true);
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
    await expectHeaderFits(page);
    await page.getByRole('button', { name: 'Navigate workspace family' }).click();
    await expect(page.getByRole('menu')).toContainText('Waiting');
    await expect(page.getByRole('menu')).toContainText('Working');
    await expect(page.getByRole('menu').locator('[aria-current="page"]')).toBeVisible();
  });
  test(`workspace header keeps controls reachable at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/__mobile-baseline?surface=header');
    await expect(page.getByRole('button', { name: /Pull requests and updates/ })).toBeVisible();
    await expectHeaderFits(page);
    await expect(page.locator('header')).toHaveScreenshot(`workspace-header-${width}.png`);
    await page.getByRole('button', { name: 'Open project menu' }).click();
    await expect(
      page.getByRole('menuitem', {
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
    await expect(page.getByRole('menu', { includeHidden: true })).toHaveCount(0);
    if (width < 1152) {
      const createPrIsInline = await page
        .locator('header')
        .getByRole('button', { name: 'Create PR', exact: true })
        .isVisible();
      await page.getByRole('button', { name: 'More actions' }).click();
      for (const name of [
        'View details',
        'Rename workspace',
        'Provider settings',
        'Open in VS Code',
        'Open dev app',
        'Open branch on GitHub',
        '#3456',
        'Archive workspace',
      ]) {
        await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
      }
      const createPrInMenu = page.getByRole('menuitem', { name: 'Create PR', exact: true });
      await expect(createPrInMenu).toHaveCount(createPrIsInline ? 0 : 1);
      if (!createPrIsInline) {
        await expect(createPrInMenu).toBeVisible();
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
      const settings = page.getByRole('dialog', { name: 'Session provider defaults', exact: true });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(settings).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
    }
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Search metadata', exact: true })
    ).toBeFocused();
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
      await expectHeaderFits(page);
      await expect(page.locator('header')).toHaveScreenshot(`${variant}-header-${width}.png`);
    });
  }
}

for (const width of [375, 810]) {
  for (const variant of ['workspace', 'project']) {
    test(`${variant} project retry keeps context at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(`/__mobile-baseline?surface=header&header=${variant}&projectsError=1`);
      await expect(page.getByRole('alert')).toContainText('Project refresh unavailable');
      await expectHeaderFits(page);
      const currentProject = page.getByRole('button', {
        name: 'Open project menu',
        exact: true,
      });
      await expect(currentProject).toBeVisible();
      await expect(page.locator('header')).toHaveScreenshot(
        `${variant}-header-project-error-${width}.png`
      );
      await page.getByRole('button', { name: 'Open project menu' }).click();
      await expect(
        page.getByRole('menuitem', {
          name: 'Factory Factory with an exceptionally long project name',
          exact: true,
        })
      ).toBeVisible();
      const retry = page.getByRole('menuitem', { name: 'Retry projects', exact: true });
      await expect(retry).toBeVisible();
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Project retry count')).toHaveText('1');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(currentProject).toBeVisible();
      await expectHeaderFits(page);
      if (variant === 'workspace') {
        await page.getByRole('combobox', { name: /Open workspace menu/ }).click();
        await expect(page.getByText('Waiting · 0')).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button', { name: 'Open project menu' }).click();
      await expect(page.getByRole('menuitem', { name: 'Retry projects', exact: true })).toHaveCount(
        0
      );
      await expect(
        page.getByRole('menuitem', { name: '+ Create project', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: 'Manage projects…', exact: true })
      ).toBeVisible();
    });
  }
}

for (const width of [320, 390]) {
  test(`mobile header keeps the same height across pages at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    const heights: number[] = [];
    for (const variant of ['workspace', 'family', 'project', 'generic']) {
      await page.goto(`/__mobile-baseline?surface=header&header=${variant}`);
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
      heights.push(
        await page.locator('header').evaluate((el) => el.getBoundingClientRect().height)
      );
      const toggle = await page.getByRole('button', { name: 'Toggle sidebar' }).boundingBox();
      const context = await page.locator('[data-slot="header-context"]').boundingBox();
      const search = await page.getByRole('button', { name: 'Search', exact: true }).boundingBox();
      if (!(toggle && context && search)) {
        throw new Error('Header navigation or search is missing');
      }
      expect(context.x).toBeGreaterThanOrEqual(toggle.x + toggle.width);
      expect(
        Math.abs(context.y + context.height / 2 - toggle.y - toggle.height / 2)
      ).toBeLessThanOrEqual(1);
      expect(search.x).toBeGreaterThanOrEqual(context.x + context.width);
      expect(
        Math.abs(search.y + search.height / 2 - toggle.y - toggle.height / 2)
      ).toBeLessThanOrEqual(1);
      await expectHeaderFits(page);
    }
    expect(heights[1]).toBe(heights[0]);
    expect(heights[2]).toBe(heights[0]);
    expect(heights[3]).toBe(heights[0]);
  });
}
