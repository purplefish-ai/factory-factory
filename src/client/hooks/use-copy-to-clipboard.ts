import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const COPIED_RESET_MS = 2000;

/**
 * Copies text and reports a short-lived `copied` flag for button feedback.
 * Clipboard failures (denied permission, insecure context) show an error toast.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
      return false;
    }
    setCopied(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return true;
  }, []);

  return { copied, copy };
}
