import { useEffect, useRef, useState } from 'react';

/** Streaming Markdown re-parses at most this often (text deltas arrive every ~25 ms). */
export const STREAMING_TEXT_INTERVAL_MS = 100;

/**
 * Returns `text` unchanged when not streaming. While streaming, returns a
 * snapshot that trails `text` by at most `intervalMs`, so expensive rendering
 * runs a few times per second instead of on every delta. The latest text is
 * always committed at the trailing edge, and returned immediately once
 * streaming ends.
 */
export function useStreamingTextSnapshot(
  text: string,
  streaming: boolean,
  intervalMs = STREAMING_TEXT_INTERVAL_MS
): string {
  const [snapshot, setSnapshot] = useState(text);
  const lastCommitRef = useRef(0);

  useEffect(() => {
    if (snapshot === text) {
      return;
    }
    if (!streaming) {
      // Keep the snapshot current so a later streaming phase starts from it.
      setSnapshot(text);
      return;
    }
    const wait = Math.max(0, lastCommitRef.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      lastCommitRef.current = Date.now();
      setSnapshot(text);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, streaming, snapshot, intervalMs]);

  return streaming ? snapshot : text;
}
