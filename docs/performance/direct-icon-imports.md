# Direct Phosphor imports

Use the package's documented per-icon ESM entry points:

```ts
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
```

The installed package README documents this form and its exports map supports
these paths. Props, icon weights, and accessible names remain unchanged. The
icon policy test scans root and direct imports, retaining the deprecated-name
and fill-weight rules, and prohibits application barrel imports. Existing
module-specific test doubles use the same direct paths.

## Unused icon weights

Each `dist/defs/<Name>.es.js` module ships SVG paths for all six weights. The
`phosphorIconWeights` Vite plugin in `scripts/phosphor-icon-weights.ts` keeps
`regular` plus the per-icon weights listed in `phosphorWeightAllowlist`. It runs
for production builds, the dev server's dependency pre-bundling, and Storybook,
which loads `vite.config.ts`. Its plugin names include the allowlist, so editing
the list invalidates Vite's dependency cache. If a defs module does not have the
expected `new Map([[weight, element], ...])` shape with all six weights, the
build fails instead of emitting icons without paths.

The icon policy test in `src/lib/icon-library.test.ts` parses source and fails
for weights outside the allowlist and for unused allowlist entries. Write
weights as string literals or conditionals of literals on a Phosphor icon
element. A weight on another tag, such as a dynamically chosen `<Icon />`,
applies to every Phosphor icon the file imports. Weight props in objects,
non-literal weights, and Phosphor imports other than `dist/csr/<Name>` and
`dist/lib/types` are rejected. To use a new weight, add the icon to the
allowlist.

With `pnpm exec vite build --manifest`, the entry chunk changes from 493 KB /
144 KB gzip to 412 KB / 124 KB gzip. The startup static closure changes from
1,067 KB / 329 KB gzip to 963 KB / 303 KB gzip. Total emitted JavaScript shrinks
by 262 KB.

## Local comparison

Matching source before/after the import change, macOS arm64, Node 26.8.1,
headless Chrome, single samples:

| Measurement                          | Barrel imports | Direct imports |
| ------------------------------------ | -------------: | -------------: |
| Cold Vite server ready               |          85 ms |          64 ms |
| Cold Vite first rendered SVG         |       2,708 ms |       1,561 ms |
| Vite production build wall time      |         1.34 s |         0.98 s |
| Vite modules transformed             |          8,747 |          4,406 |
| Storybook server ready               |       1,356 ms |       1,151 ms |
| First file viewer story              |       8,900 ms |       4,208 ms |
| Storybook production build wall time |        12.37 s |         6.14 s |

The production entry changes from 1,869 KB / 571 KB gzip to 337 KB / 103 KB
gzip. This also changes chunk partitioning: individual icon imports allow
existing lazy routes to retain their own dependencies. This measurement is
independent of the file viewer worker change.

Timing samples include local cache and resource effects; repeat before drawing
statistical conclusions. The Vite runs use fresh temporary dependency caches and
the same unavailable backend, so real application data latency is not measured.
Storybook retains its normal cache; these are local startup/build comparisons,
not a controlled cold-cache experiment. Its fixture supplies its own query data.

## Reproduction

With installed Google Chrome, run from each compared checkout:

```sh
node scripts/benchmarks/icon-startup.mjs comparison-label
node scripts/benchmarks/storybook-startup.mjs "$PWD" comparison-label
/usr/bin/time -p pnpm exec vite build
/usr/bin/time -p pnpm build:storybook
```

Vite startup uses a fresh temporary dependency cache. Storybook startup uses
port 6029 and waits for the file viewer fixture's highlighted `greeting` token.
Stop any existing Storybook server on that port before comparing checkouts.
