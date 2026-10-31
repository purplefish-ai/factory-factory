# Brand assets

Factory Factory's logo is a black six-tooth gear with a circular bore on safety
yellow (`#FFE500`). The vector follows the approved concept's individual tooth
proportions and curved recesses. Its silhouette has 99.8%
intersection-over-union with the concept at the original 1254-pixel size; the
center opening is a true circle. There are no fonts or embedded bitmaps in the
symbol.

The editable source is
[`src/client/assets/logo.svg`](../src/client/assets/logo.svg). The React
`LogoIcon` imports this file through Vite so asset URLs work with deployment
prefixes and deep routes. Keep the existing wordmark for layouts that also show
the product name.

Regenerate exports after changing the source, using ImageMagick 7:

```sh
node scripts/generate-brand-assets.mjs
```

- `public/gear.svg`: transparent symbol, including a transparent bore.
- `public/logo.svg` and `public/logo.png`: yellow tile, 512-pixel PNG.
- `public/favicon.svg`: browser and notification icon.
- `public/logo-full.svg` and `public/logo-full-dark.svg`: wordmark lockups.
- `public/logo.sips.png`: legacy 80-pixel export.
- `public/icons/app-192.png`: Android installation icon, 192 pixels.
- `public/icons/apple-touch-icon.png`: Apple touch icon, 180 pixels.
- `build-resources/icon.{svg,png,ico,icns}`: desktop packaging icons.

The installation icon paths match
[PWA PR #2729](https://github.com/purplefish-ai/factory-factory/pull/2729): its
manifest uses `icons/app-192.png` and `logo.png`, and its HTML links
`icons/apple-touch-icon.png`. When combining the branches, retain these gear
PNGs instead of the older artwork added by that PR. This change prepares the
artwork; the manifest and installation behavior remain in the PWA PR.

The PNG backgrounds are opaque yellow with square corners. The operating system
applies its own icon shape. Do not bake rounded corners into PWA exports.
