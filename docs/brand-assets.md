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
prefixes and deep routes.

The wordmark uses the unmodified **Jost Black (900)** font, with two uppercase
lines in the same font, weight, color, and full opacity, normal kerning, and
`-0.01em` letter spacing. Both rows inherit these styles from the shared
`LogoText` wrapper; do not add per-row font, color, or opacity overrides. The
app loads it locally from `public/fonts/jost/Jost-900-Black.ttf`; it needs no
font CDN or installed system font. Its size can be set with `LogoText`'s
`className` or `Logo`'s `textClassName`.

The font is from
[indestructible type's Jost project](https://github.com/indestructible-type/Jost),
revision `35f141c970538f1ed0f235789c19156b3ce2a762`. The original font copyright
notice and the complete
[SIL Open Font License 1.1 text](https://openfontlicense.org/open-font-license-official-text/)
are included at `public/fonts/jost/OFL.txt`, which ships with the application.
The font remains under the OFL; the application remains MIT-licensed.

Regenerate exports after changing the source, using ImageMagick 7 and the
installed development dependencies:

```sh
pnpm brand:generate
```

- `public/gear.svg`: transparent symbol, including a transparent bore.
- `public/logo.svg` and `public/logo.png`: yellow tile, 512-pixel PNG.
- `public/favicon.svg`: browser and notification icon.
- `public/logo-full.svg` and `public/logo-full-dark.svg`: wordmark lockups.
- `public/wordmark.svg` and `public/wordmark-dark.svg`: standalone wordmarks.
- `public/logo.sips.png`: legacy 80-pixel export.
- `public/icons/app-192.png`: Android installation icon, 192 pixels.
- `public/icons/apple-touch-icon.png`: Apple touch icon, 180 pixels.
- `build-resources/icon.{svg,png,ico,icns}`: desktop packaging icons.

The README selects `logo-full-dark.svg` (white lettering) for dark mode and
`logo-full.svg` (black lettering) for light mode using a `<picture>` element.
The light version is also the fallback for renderers without theme support.

The SVG wordmark exports contain outlines generated directly from the bundled
Jost font using OpenType.js. They retain the font's letterforms and spacing
without depending on font loading in image viewers or on GitHub. The gear-only
favicon, PWA, and desktop icons share the original gear source.

The web app manifest uses `icons/app-192.png` and `logo.png`, and the HTML links
`icons/apple-touch-icon.png` for iOS. All three installation icons are generated
from the same gear source as the app and browser icons.

The PNG backgrounds are opaque yellow with square corners. The operating system
applies its own icon shape. Do not bake rounded corners into PWA exports.
