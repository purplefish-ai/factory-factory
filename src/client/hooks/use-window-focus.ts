import { useEffect, useState } from 'react';

/**
 * Track whether the app window is focused.
 * Works in both browser and Electron.
 */
export function useWindowFocus(): boolean {
  const [isFocused, setIsFocused] = useState(() => {
    // Initial state
    if (typeof document !== 'undefined') {
      return document.hasFocus();
    }
    return true;
  });

  useEffect(() => {
    // Check if running in Electron with focus API
    if (window.electron?.onWindowFocusChanged) {
      return window.electron.onWindowFocusChanged(setIsFocused);
    }

    // Fallback to browser APIs
    const handleFocus = () => setIsFocused(true);
    const handleBlur = () => setIsFocused(false);
    const handleVisibilityChange = () => {
      setIsFocused(!document.hidden && document.hasFocus());
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isFocused;
}
