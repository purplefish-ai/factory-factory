import { expect, test, type Page } from '@playwright/test';

async function assertEditorBounds(page: Page) {
  const main = page.locator('main');
  await expect(main).not.toContainText('Factory Factory');
  const editor = await main.boundingBox();
  const rail = await page.getByRole('navigation', { name: 'Agents', exact: true }).boundingBox();
  expect(editor).not.toBeNull();
  expect(rail).not.toBeNull();
  if (!(editor && rail)) {
    throw new Error('Missing Agents panels');
  }
  expect(editor.y).toBeGreaterThanOrEqual(rail.y + rail.height - 1);
  expect(editor.width).toBeGreaterThanOrEqual(400);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  const scheduleControl = main.getByRole('combobox', { name: 'Schedule', exact: true });
  if (await scheduleControl.count()) {
    const schedule = await scheduleControl.boundingBox();
    const time = await main.getByLabel('Run time (optional)').boundingBox();
    const formWidth = (await main.locator('form').boundingBox())?.width ?? 0;
    expect(schedule && time && Math.abs(schedule.y - time.y) < 1).toBe(formWidth >= 416);
  }
  for (const control of await main.locator('input, textarea, [role="combobox"]').all()) {
    const box = await control.boundingBox();
    if (!box) {
      throw new Error('Missing form control');
    }
    expect(box.width).toBeGreaterThanOrEqual(200);
    expect(box.x).toBeGreaterThanOrEqual(editor.x);
    expect(box.x + box.width).toBeLessThanOrEqual(editor.x + editor.width + 1);
  }
}

for (const width of [768, 810, 1024, 1280]) {
  test(`Agents use available content width with expanded sidebar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      (sidebarWidth) => localStorage.setItem('sidebar_width', String(sidebarWidth)),
      352
    );
    await page.goto('/__mobile-baseline?surface=agents');
    if (width === 1280) {
      const handle = await page
        .getByRole('button', { name: 'Resize sidebar', exact: true })
        .boundingBox();
      if (!handle) {
        throw new Error('Missing sidebar resize handle');
      }
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 288, handle.y + handle.height / 2);
      await page.mouse.up();
    }

    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    await assertEditorBounds(page);
    await page.screenshot({
      path: test.info().outputPath(`detail-${width}.png`),
    });
    await page.getByRole('button', { name: 'Edit Agent', exact: true }).click();
    await assertEditorBounds(page);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep edit draft');
    await page.setViewportSize({ width: 1700, height: 1000 });
    const wideEditor = await page.locator('main').boundingBox();
    const wideRail = await page
      .getByRole('navigation', { name: 'Agents', exact: true })
      .boundingBox();
    expect(wideEditor?.x).toBeGreaterThanOrEqual((wideRail?.x ?? 0) + (wideRail?.width ?? 0));
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
      'Keep edit draft'
    );
    await page.setViewportSize({ width, height: 1000 });
    await assertEditorBounds(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Create Agent', exact: true }).click();
    await assertEditorBounds(page);
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true });
    await name.fill('Keep creation draft');
    await instructions.fill('Review layout only');
    await page.getByLabel('Run time (optional)').fill('09:30');
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.setViewportSize({ width, height: 1000 });
    await expect(name).toHaveValue('Keep creation draft');
    await page.screenshot({
      path: test.info().outputPath(`create-${width}.png`),
    });
    await expect(instructions).toHaveValue('Review layout only');
    await expect(page.getByLabel('Run time (optional)')).toHaveValue('09:30');
    await assertEditorBounds(page);
  });
}
