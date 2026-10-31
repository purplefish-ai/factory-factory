import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const iconPath = fileURLToPath(new URL('../build-resources/icon.icns', import.meta.url));

it('packages a 64-pixel PNG in the macOS 32-pixel Retina slot', () => {
  const icon = readFileSync(iconPath);
  expect(icon.toString('ascii', 0, 4)).toBe('icns');
  expect(icon.readUInt32BE(4)).toBe(icon.length);

  let retina: Buffer | undefined;
  for (let offset = 8; offset < icon.length;) {
    const size = icon.readUInt32BE(offset + 4);
    expect(size).toBeGreaterThan(8);
    expect(offset + size).toBeLessThanOrEqual(icon.length);
    if (icon.toString('ascii', offset, offset + 4) === 'ic12') {
      retina = icon.subarray(offset + 8, offset + size);
    }
    offset += size;
  }

  expect(retina, 'missing the native 32x32@2x icon representation').toBeDefined();
  if (!retina) {
    throw new Error('Missing Retina icon');
  }
  expect(retina.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([retina.readUInt32BE(16), retina.readUInt32BE(20)]).toEqual([64, 64]);
});

it.runIf(process.platform === 'darwin')('decodes the Retina icon at 64 pixels on macOS', () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-brand-icons-'));
  const output = join(root, 'app.iconset');
  try {
    execFileSync('iconutil', ['--convert', 'iconset', '--output', output, iconPath]);
    const png = readFileSync(join(output, 'icon_32x32@2x.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
