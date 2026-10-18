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
