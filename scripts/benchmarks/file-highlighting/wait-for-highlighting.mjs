// Shared by the render benchmark and the cold chunk-loading browser fixture.
export async function waitForHighlighting(node, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!node.querySelector('.token.keyword')) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for syntax highlighting after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

// Evaluate readiness and diagnostics together so captured state cannot drift
// from the predicate. This function runs in the benchmark page's browser realm.
function readPreviewSamples() {
  return [...document.querySelectorAll('#root pre.file-code')].map((pre, index) => {
    const rect = pre.getBoundingClientRect();
    const settled = pre.getAttribute('aria-busy') === 'false';
    const visible = rect.top >= 0 && rect.bottom <= innerHeight;
    const textColor = getComputedStyle(pre).color;
    const colored = [...pre.querySelectorAll('.token')].some(
      (token) => getComputedStyle(token).color !== textColor
    );
    return {
      index,
      theme: pre.getAttribute('data-syntax-theme'),
      language: pre.querySelector('code')?.className,
      settled,
      visible,
      colored,
      ready: settled && visible && colored,
    };
  });
}

export async function waitForHighlightingPreview(page, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const samples = await page.evaluate(readPreviewSamples);
    if (samples.length === 16 && samples.every((sample) => sample.ready)) {
      return samples;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out waiting for 16 highlighted preview samples after ${timeoutMs} ms; received ${samples.length}; unready: ${JSON.stringify(samples.filter((sample) => !sample.ready))}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(16, remaining)));
  }
}
