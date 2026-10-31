import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

// Run with ImageMagick installed: pnpm brand:generate
// The React import and every exported icon share this vector source.
const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = join(root, 'src/client/assets/logo.svg');
const source = readFileSync(sourcePath, 'utf8');
const fontBytes = readFileSync(join(root, 'public/fonts/jost/Jost-900-Black.ttf'));
const font = opentype.parse(
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength)
);
// Match logo.css: Jost Black, normal kerning, -0.01em letter spacing.
const letters = font.getPath('FACTORY', 0, 0, 100, { kerning: true, letterSpacing: -0.01 });
const bounds = letters.getBoundingBox();
const wordWidth = bounds.x2 - bounds.x1;
const lineHeight = bounds.y2 - bounds.y1;
const linePitch = lineHeight + 6;
const wordHeight = lineHeight * 2 + 6;
const outline = letters.toPathData({ decimalPlaces: 3, flipY: false });
const temporary = mkdtempSync(join(tmpdir(), 'factory-brand-'));

function rasterize(size, destination) {
  execFileSync('magick', [
    join(temporary, 'master.png'),
    '-resize',
    `${size}x${size}`,
    '-strip',
    `PNG24:${join(root, destination)}`,
  ]);
}

function wordmarkPaths(color) {
  return `<g fill="${color}">
    <path transform="translate(${-bounds.x1} ${-bounds.y1})" d="${outline}" />
    <path transform="translate(${-bounds.x1} ${-bounds.y1 + linePitch})" d="${outline}" />
  </g>`;
}

function standaloneWordmark(dark) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wordWidth}" height="${wordHeight}" viewBox="0 0 ${wordWidth} ${wordHeight}">
  <title>Factory Factory</title>
  ${wordmarkPaths(dark ? '#FAFAFA' : '#0A0A0A')}
</svg>
`;
}

function wordmark(dark) {
  const icon = source.replace('<svg ', '<svg x="8" y="8" width="104" height="104" ');
  return `<svg width="400" height="120" viewBox="0 0 400 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>Factory Factory</title>
  ${icon.trim()}
  <g transform="translate(132 20) scale(${80 / wordHeight})">
    ${wordmarkPaths(dark ? '#FAFAFA' : '#0A0A0A')}
  </g>
</svg>
`;
}

try {
  mkdirSync(join(root, 'public/icons'), { recursive: true });
  writeFileSync(join(root, 'public/logo.svg'), source);
  writeFileSync(
    join(root, 'public/favicon.svg'),
    source.replace('<svg ', '<svg width="32" height="32" ')
  );
  writeFileSync(join(root, 'public/gear.svg'), source.replace(/\s*<rect[^>]+\/>/, ''));
  writeFileSync(join(root, 'build-resources/icon.svg'), source);
  writeFileSync(join(root, 'public/logo-full.svg'), wordmark(false));
  writeFileSync(join(root, 'public/logo-full-dark.svg'), wordmark(true));
  writeFileSync(join(root, 'public/wordmark.svg'), standaloneWordmark(false));
  writeFileSync(join(root, 'public/wordmark-dark.svg'), standaloneWordmark(true));

  execFileSync('magick', [
    '-background',
    'none',
    '-density',
    '384',
    sourcePath,
    '-resize',
    '1024x1024',
    '-strip',
    `PNG24:${join(temporary, 'master.png')}`,
  ]);
  for (const [size, destination] of [
    [512, 'public/logo.png'],
    [80, 'public/logo.sips.png'],
    [192, 'public/icons/app-192.png'],
    [180, 'public/icons/apple-touch-icon.png'],
    [512, 'build-resources/icon.png'],
  ]) {
    rasterize(size, destination);
  }
  execFileSync('magick', [
    join(temporary, 'master.png'),
    '-strip',
    '-define',
    'icon:auto-resize=256,128,64,48,32,16',
    join(root, 'build-resources/icon.ico'),
  ]);

  // PNG-backed ICNS chunks keep generation portable; no macOS iconutil needed.
  const chunks = [];
  for (const [type, size] of [
    ['icp4', 16],
    ['icp5', 32],
    ['ic12', 64], // 32x32@2x: 64 physical pixels, interpreted as Retina by macOS.
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ]) {
    const png = execFileSync('magick', [
      join(temporary, 'master.png'),
      '-resize',
      `${size}x${size}`,
      '-strip',
      'PNG24:-',
    ]);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
  writeFileSync(join(root, 'build-resources/icon.icns'), Buffer.concat([header, ...chunks]));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
