/** Plays a sound asset from `public/`. Fails silently — autoplay-blocked or missing audio isn't critical. */
export function playSound(relativePath: string, opts?: { volume?: number }): void {
  try {
    const audio = new Audio(`${import.meta.env.BASE_URL}${relativePath}`);
    audio.volume = opts?.volume ?? 0.5;
    audio.play().catch(() => {
      // Autoplay blocked — non-critical, ignore.
    });
  } catch {
    // Autoplay blocked or audio failed to load — non-critical, ignore.
  }
}
