import { useEffect } from 'react';
import { triggerShortcut } from '@/client/lib/shortcut-registry';

/** Native menu and command palette actions use the same mounted handlers. */
export function useDesktopCommands() {
  useEffect(() => window.electronAPI?.onAppCommand?.(triggerShortcut), []);
}
