# xterm WebGL renderer trial

Keep the existing default terminal renderer. The matched xterm 6.0.0 and
addon-webgl 0.19.0 trial does not demonstrate a consistent replay, burst, or
frame-time improvement for this workload. It adds initialization work and GPU
resources. No production dependency or terminal behavior changes are included.

## Reproduce

```sh
node scripts/benchmarks/terminal-webgl.mjs
```

Run from a repository checkout with its dependencies installed. The script
imports the checkout's `vite` and `@playwright/test` packages; it also requires
installed Google Chrome, `pnpm` on PATH, and network access to install the two
pinned xterm packages in a temporary directory. It serves an isolated Vite
fixture, compares the default renderer against WebGL, checks context-loss and
unsupported-GPU fallback, then removes the temporary installation. It does not
install into the application or change its lockfile.

Each case runs three times with one, four, and eight visible terminals in a
1280×1000 viewport. Terminals use 32 columns, 14 rows, and a 12 px font. Each
receives a 6,000-row colored ANSI replay followed by thirty 50-row bursts. Both
renderers receive identical bytes; the final buffer text is asserted. Timings
include write completion and two animation frames. A warmup precedes replay. The
harness reports GPU backend, frame intervals, estimated atlas bytes, live
contexts after disposal, and both fallback checks.

## Hardware measurements

macOS arm64, Node 26.8.1, Chrome headless using
`ANGLE Metal Renderer: Apple M4`. Medians of three local samples, milliseconds:

| Terminals | Renderer | Synchronous initialization | First usable output | Replay | Bursts | Largest frame interval |
| --------- | -------- | -------------------------: | ------------------: | -----: | -----: | ---------------------: |
| 1         | Default  |                        2.0 |                33.3 |   33.9 |  149.2 |                   16.8 |
| 1         | WebGL    |                        7.0 |                34.1 |   32.9 |  149.9 |                   16.8 |
| 4         | Default  |                        4.2 |                32.4 |   34.7 |  150.0 |                   16.7 |
| 4         | WebGL    |                       22.3 |                34.8 |   33.2 |  149.7 |                   16.7 |
| 8         | Default  |                        7.9 |                35.0 |   60.7 |  155.7 |                   33.3 |
| 8         | WebGL    |                       49.1 |                66.5 |   57.2 |  160.0 |                   33.3 |

An earlier full run measured eight-terminal replay 54.1/56.9 ms and bursts
160.7/160.5 ms for default/WebGL, respectively. Differences change direction
between runs. This small local experiment supports deferring a default change;
it does not establish performance on other GPUs, terminal sizes, or workloads.

## Lifecycle and memory

WebGL allocates one active context per terminal. The exposed atlas dimensions
imply approximately 1 MiB of RGBA atlas storage per terminal: 1, 4, and 8 MiB
for these cases. This is an estimate, not total GPU process memory; it excludes
other buffers and driver overhead. Browser APIs do not expose reliable total GPU
allocation here.

After `terminal.dispose()`, the retained WebGL context references still report
`isContextLost() === false` in all cases. This shows that contexts are not
explicitly lost at disposal, rather than proving retention after garbage
collection. The harness explicitly loses retained contexts before the next
sample. The related upstream lifecycle issue is
[xtermjs/xterm.js#6068](https://github.com/xtermjs/xterm.js/issues/6068).

The browser checks also verify:

- A forced context loss fires one addon notification; disposing the addon
  restores the default renderer and subsequent text remains readable.
- With WebGL disabled, addon activation fails and the default renderer still
  displays the expected output.

The addon waits three seconds for context restoration before emitting its loss
notification. A future implementation would need an owned subscription, reliable
disposal and fallback, and a larger workload/device comparison before default
enablement. The existing FitAddon and terminal lifecycle remain as-is.
