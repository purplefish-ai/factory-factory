import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'fold-closed', width: 344, height: 882 },
  { name: 'fold-open', width: 690, height: 829 },
  { name: 'fold-open-large', width: 800, height: 720 },
]) {
  test(`workspace tools drawer - ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.routeWebSocket(/\/terminal\?/, (ws) => {
      ws.send(
        JSON.stringify({
          type: 'terminal_list',
          terminals: [
            { id: 'terminal-1', createdAt: '2026-01-01', outputBuffer: 'Ready to work\r\n$ ' },
          ],
        })
      );
      ws.onMessage((message) => {
        const value = JSON.parse(String(message));
        if (value.type === 'input') {
          ws.send(JSON.stringify({ type: 'output', terminalId: 'terminal-1', data: value.data }));
        }
      });
    });
    await page.routeWebSocket(/\/(dev-logs|post-run-logs)\?/, () => {
      /* Keep fixture log streams open without backend traffic. */
    });
    await page.goto('/__mobile-baseline?surface=tools');
    const open = page.getByRole('button', { name: 'Open tools' });
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace tools' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('component-0.tsx', { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const rect = await drawer.boundingBox();
        return Math.round((rect?.x ?? 0) + (rect?.width ?? 0));
      })
      .toBe(viewport.width);
    const bounds = await drawer.boundingBox();
    expect(bounds?.x).toBeGreaterThan(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeCloseTo(viewport.width, 0);
    await expect(drawer.locator('.xterm')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(drawer.locator('.xterm')).toBeVisible();
    await expect(drawer.locator('.xterm-helper-textarea')).not.toBeFocused();
    await drawer.getByRole('application', { name: 'Terminal' }).click();
    await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.type('pwd');
    await drawer.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(drawer.locator('.xterm')).toBeHidden();
    await expect(drawer.getByText('component-0.tsx', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(drawer.locator('.xterm-helper-textarea')).not.toBeFocused();
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
    await open.click();
    await expect(drawer.locator('.xterm')).toBeVisible();
    await expect(drawer.locator('.xterm-helper-textarea')).not.toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    if (viewport.name === 'fold-closed') {
      await page.setViewportSize({ width: 800, height: 720 });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('.xterm')).toBeVisible();
      await expect(drawer.locator('.xterm-helper-textarea')).not.toBeFocused();
      await page.setViewportSize(viewport);
      await expect(drawer.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    }
    await page.screenshot({
      animations: 'disabled',
      path: `test-results/mobile/${viewport.name}-tools.png`,
    });
  });
}
