import { expect, type Locator, test } from '@playwright/test';

function gap(viewport: Locator) {
  return viewport.evaluate((element) =>
    Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
  );
}

test('new transcript starts at latest and follows viewport resizing', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Resize viewport', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('same-key tool bursts and activity changes stay attached', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.evaluate((element) => element.setAttribute('data-scroll-probe', 'running'));
  const sampledPositions = viewport.evaluate(async (element) => {
    const positions: Array<{ top: number; max: number }> = [];
    while (element.hasAttribute('data-scroll-probe')) {
      await new Promise(requestAnimationFrame);
      positions.push({
        top: element.scrollTop,
        max: Math.max(0, element.scrollHeight - element.clientHeight),
      });
    }
    return positions;
  });
  await page.getByRole('button', { name: 'Tool burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const groupToggle = viewport.locator('[data-tool-sequence="true"] button[aria-expanded]').first();
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');
  await groupToggle.click();
  await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const count = await viewport.locator('[data-transcript-key]').count();
  await page.getByRole('button', { name: 'Tool burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  expect(await viewport.locator('[data-tool-sequence="true"]').count()).toBe(1);
  expect(await viewport.locator('[data-transcript-key]').count()).toBeLessThanOrEqual(count + 1);
  await page.getByRole('button', { name: 'Toggle activity', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.evaluate((element) => element.removeAttribute('data-scroll-probe'));
  const positions = await sampledPositions;
  expect(positions.length).toBeGreaterThan(0);
  const backwardFrames = positions.flatMap((top, index) => {
    const previous = positions[index - 1] ?? top;
    // Replacing estimates can shrink the extent while we remain at the end.
    // Reject backward corrections beyond that legitimate geometry change.
    const shrink = Math.max(0, previous.max - top.max);
    return top.top < previous.top - shrink - 1 ? [{ index, previous, top }] : [];
  });
  expect(backwardFrames).toEqual([]);
  const previousGroupKey = await viewport
    .locator('[data-tool-sequence="true"]')
    .getAttribute('data-transcript-key');
  expect(previousGroupKey).not.toBeNull();
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Tool burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await expect(viewport.locator('[data-tool-sequence="true"]')).not.toHaveAttribute(
    'data-transcript-key',
    previousGroupKey ?? 'missing'
  );
});

test('inline task updates share the measured tail and preserve scroll intent', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const spacer = viewport.locator(':scope > div');
  const before = await spacer.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Toggle tasks', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tasks', exact: true })).toBeVisible();
  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(before);
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Toggle tasks', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tasks', exact: true })).toHaveCount(0);
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -700);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  await page.getByRole('button', { name: 'Toggle tasks', exact: true }).click();
  await viewport.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expectAnchor(viewport, anchor);
  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tasks', exact: true })).toBeVisible();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('upward input yields immediately and the jump overlay does not resize the viewport', async ({
  page,
}) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const height = await viewport.evaluate((element) => element.clientHeight);
  await viewport.hover();
  await page.mouse.wheel(0, -500);
  const jump = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
  await expect(jump).toBeVisible();
  expect(await viewport.evaluate((element) => element.clientHeight)).toBe(height);
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await viewport.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(top);
  await jump.click();
  await expect(jump).toBeHidden();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('pane return resumes following and preserves a reading position', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Hide or show', exact: true }).click();
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await page.getByRole('button', { name: 'Hide or show', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  await page.getByRole('button', { name: 'Hide or show', exact: true }).click();
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await page.getByRole('button', { name: 'Hide or show', exact: true }).click();
  // Re-enabling the engine may re-estimate its prefix; preserve visible content.
  await expectAnchor(viewport, anchor);
});

test('reading anchor survives prepend and session switching', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  await page.getByRole('button', { name: 'Prepend history', exact: true }).click();
  await expectAnchor(viewport, anchor);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await expectAnchor(viewport, anchor);
});

test('reading inside a row gap survives prepend and a session round trip', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await viewport.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-transcript-key]')].find(
      (item) => item.getBoundingClientRect().top > viewportTop + 20
    );
    if (!row?.dataset.transcriptKey) {
      throw new Error('Missing row after the reading position');
    }
    element.scrollTop += row.getBoundingClientRect().top - viewportTop - 4;
    element.dispatchEvent(new Event('scroll'));
    return { key: row.dataset.transcriptKey, top: viewportTop + 4 };
  });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('workspace-panel-scroll-fixture-W1')))
    .toContain('"offset":-4');
  await page.getByRole('button', { name: 'Prepend history', exact: true }).click();
  await expectAnchor(viewport, anchor);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await expectAnchor(viewport, anchor);
});

test('engine start anchoring never implicitly follows same-key growth', async ({ page }) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Grow engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeGreaterThanOrEqual(199);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(top);
});

test('engine native end anchoring follows append and same-key growth', async ({ page }) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'Toggle native follow', exact: true }).click();
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Append engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Grow engine row', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('transcript follows a burst of output', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('engine compensates a late above-viewport resize after backward input and cancellation', async ({
  page,
}) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await viewport.hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => gap(viewport)).toBeGreaterThan(500);
  const anchor = await viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-row-key]')].find(
      (item) => item.getBoundingClientRect().bottom > top
    );
    return { key: row?.dataset.rowKey, top: row?.getBoundingClientRect().top };
  });
  expect(anchor.key).toBeDefined();
  const spacer = viewport.locator(':scope > div');
  const extent = await spacer.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Grow preceding engine row', exact: true }).click();
  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(extent + 200);
  await expect
    .poll(async () => (await viewport.locator(`[data-row-key="${anchor.key}"]`).boundingBox())?.y)
    .toBe(anchor.top);
  await expect.poll(() => gap(viewport)).toBeGreaterThan(500);
});

test('engine measures a newly mounted row taller than the viewport without shifting its top', async ({
  page,
}) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'Prepend giant engine row', exact: true }).click();
  const row = viewport.locator('[data-row-key="999"]');
  await expect.poll(async () => (await row.boundingBox())?.height).toBe(1200);
  await expect
    .poll(() =>
      viewport.locator(':scope > div').evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBe(4400);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Prepend giant engine row', exact: true }).click();
  await expect(viewport.locator('[data-row-key="1000"]')).toHaveAttribute(
    'data-engine-measured-height',
    '1200'
  );
  const keys = await viewport
    .locator('[data-row-key]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')));
  expect(new Set(keys).size).toBe(keys.length);
});

test('pinned engine clamp retries omit behavior and remain compensation', async ({ page }) => {
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await page.getByRole('button', { name: 'End command', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await viewport.evaluate((element) => {
    element.scrollTop -= 30;
    element.dispatchEvent(new Event('scroll'));
  });
  const before = Number(await viewport.getAttribute('data-deferred-writes'));
  await page.getByRole('button', { name: 'Grow preceding engine row', exact: true }).click();
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-deferred-writes')))
    .toBeGreaterThan(before);
  await expect(viewport).toHaveAttribute('data-deferred-allowed', 'true');
  await expect.poll(() => gap(viewport)).toBe(30);
});

test('pinned engine touch-held compensation flush omits behavior', async ({ page }) => {
  // Exercise the installed engine's iOS branch; this does not emulate device physics.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'iPhone Safari engine characterization',
    })
  );
  await page.goto('/__transcript-scroll?engine=1');
  const viewport = page.getByTestId('engine-viewport');
  await viewport.evaluate((element) => {
    element.scrollTop = 1600;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(viewport.locator('[data-row-key="19"]')).toBeAttached();
  const before = Number(await viewport.getAttribute('data-deferred-writes'));
  await viewport.dispatchEvent('touchstart');
  await page.getByRole('button', { name: 'Grow preceding engine row', exact: true }).click();
  await expect(viewport.locator('[data-row-key="19"]')).toHaveAttribute(
    'data-engine-measured-height',
    '280'
  );
  expect(Number(await viewport.getAttribute('data-deferred-writes'))).toBe(before);
  await viewport.dispatchEvent('touchend');
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-deferred-writes')))
    .toBeGreaterThan(before);
  await expect(viewport).toHaveAttribute('data-deferred-allowed', 'true');
});

test('held touch keeps new output inhibited despite a queued scrollend', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const top = await viewport.evaluate((element) => element.scrollTop);
  await viewport.dispatchEvent('touchstart');
  await viewport.dispatchEvent('scrollend');
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeGreaterThan(100);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(top);
  await viewport.dispatchEvent('touchend');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
});

test('hydration suspends positioning and keeps the committed reading anchor', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  await page.getByRole('button', { name: 'Toggle hydration', exact: true }).click();
  await expect(viewport).toContainText('Loading session...');
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle hydration', exact: true }).click();
  await expectAnchor(viewport, anchor);
});

test('reading clamped to the bottom by rewind does not resume following', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  const jump = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
  await expect(jump).toBeVisible();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(viewport.locator('[data-transcript-key="m-1"]')).toBeAttached();
  await expect(jump).toBeVisible();
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeGreaterThan(100);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(jump).toBeVisible();
});

test('header image sizing and text wrapping preserve follow or keyed reading intent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    window.addEventListener('error', (event) => {
      document.documentElement?.setAttribute('data-scroll-window-error', event.message);
    })
  );
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const spacer = viewport.locator(':scope > div');
  const extent = await spacer.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Resize image header', exact: true }).click();
  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    // Following may also mount and measure previously estimated message rows.
    .toBeGreaterThanOrEqual(extent + 216);
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -700);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  const readingExtent = await spacer.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Resize image header', exact: true }).click();
  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(readingExtent - 216);
  await expectAnchor(viewport, anchor);
  await page.getByRole('button', { name: 'Resize width', exact: true }).click();
  await expectAnchor(viewport, anchor);
  expect(errors).toEqual([]);
  await expect(page.locator('html')).not.toHaveAttribute('data-scroll-window-error');
});

test('workspace round trip and reload restore real persisted keyed positions', async ({ page }) => {
  await page.goto('/__transcript-scroll');
  const viewport = page.getByTestId('transcript-viewport');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -700);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  const anchor = await readingAnchor(viewport);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('workspace-panel-scroll-fixture-W1')))
    .toContain('"intent":"reading"');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expectAnchor(viewport, anchor);
  await page.reload();
  await expectAnchor(viewport, anchor);
});

function readingAnchor(viewport: Locator) {
  return viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-transcript-key]')].find(
      (item) => item.getBoundingClientRect().bottom > top
    );
    if (!row?.dataset.transcriptKey) {
      throw new Error('Missing visible keyed row');
    }
    return { key: row.dataset.transcriptKey, top: row.getBoundingClientRect().top };
  });
}
function expectAnchor(viewport: Locator, anchor: { key: string; top: number }) {
  return expect
    .poll(
      async () => (await viewport.locator(`[data-transcript-key="${anchor.key}"]`).boundingBox())?.y
    )
    .toBe(anchor.top);
}

test('thinking wrapping and completion do not move the conversation', async ({ page }) => {
  await page.goto('/__transcript-scroll?footer=1');
  const viewport = page.getByTestId('transcript-viewport');
  const footer = page.getByTestId('thinking-footer');
  await expect.poll(() => gap(viewport)).toBeLessThanOrEqual(1);
  const geometry = () =>
    viewport.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      extent: element.scrollHeight,
    }));
  const initial = await geometry();
  for (const name of ['Toggle activity', 'Change thinking', 'Toggle activity', 'Toggle activity']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(geometry).toEqual(initial);
    await expect(footer).toHaveCSS('height', '32px');
  }
  expect(await viewport.locator('[aria-label="Session activity"]').count()).toBe(0);
  await page.getByRole('button', { name: 'Show thinking preview' }).click();
  await expect(page.getByRole('dialog', { name: 'Thinking preview' })).toBeVisible();
  await expect.poll(geometry).toEqual(initial);
  await page.keyboard.press('Escape');
  await viewport.hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  // Wheel input and newly mounted row measurements can finish on later frames.
  // Capture only once both have settled, before applying thinking updates.
  await viewport.evaluate(async (element) => {
    let previous = '';
    let stableFrames = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const current = `${element.scrollTop}:${element.scrollHeight}`;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 6) {
        return;
      }
    }
    throw new Error('Reading geometry did not settle');
  });
  const reading = await geometry();
  await page.getByRole('button', { name: 'Change thinking', exact: true }).click();
  await expect.poll(geometry).toEqual(reading);
  await page.getByRole('button', { name: 'Toggle activity', exact: true }).click();
  await expect.poll(geometry).toEqual(reading);
});

test('completed thinking cannot leave focus inside a hidden preview', async ({ page }) => {
  await page.goto('/__transcript-scroll?footer=1');
  const footer = page.getByTestId('thinking-footer');
  const toggle = page.getByRole('button', { name: 'Toggle activity', exact: true });
  await toggle.click();
  const trigger = page.getByRole('button', { name: 'Show thinking preview' });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  // Complete work without moving focus to the fixture control first.
  await toggle.evaluate((button) => button.click());
  await expect
    .poll(() => footer.evaluate((element) => element.contains(document.activeElement)))
    .toBe(false);
  await expect(footer.locator(':scope > div')).toHaveAttribute('inert');
  const inactiveTrigger = footer.getByRole('button', { name: 'Show thinking preview' });
  await expect(inactiveTrigger).toBeDisabled();
  await inactiveTrigger.evaluate((button) => button.focus());
  await expect(inactiveTrigger).not.toBeFocused();
  await toggle.click();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Thinking preview' })).toBeVisible();
  await toggle.evaluate((button) => button.click());
  await expect(page.getByRole('dialog', { name: 'Thinking preview' })).toHaveCount(0);
  await expect
    .poll(() => footer.evaluate((element) => element.contains(document.activeElement)))
    .toBe(false);
});

test('thinking completion preserves focus outside the preview', async ({ page }) => {
  await page.goto('/__transcript-scroll?footer=1');
  const toggle = page.getByRole('button', { name: 'Toggle activity', exact: true });
  await toggle.click();
  const outside = page.getByRole('button', { name: 'Change thinking', exact: true });
  await outside.focus();
  await toggle.evaluate((button) => button.click());
  await expect(outside).toBeFocused();
});
