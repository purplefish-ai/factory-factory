import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  applyAppearance,
  readStoredAppearance,
  writeStoredAppearance,
} from '@/client/lib/appearance';
import { trpc } from '@/client/lib/trpc';
import {
  type AppearanceSettings,
  appearanceFromUserSettings,
  DEFAULT_APPEARANCE,
} from '@/shared/appearance';

const AppearanceContext = createContext<AppearanceSettings>(DEFAULT_APPEARANCE);

interface AppearanceProviderProps {
  children: React.ReactNode;
}

/**
 * Reads the saved appearance preferences and applies them to <html>. Must be
 * rendered inside TRPCProvider. Until the settings query resolves, consumers
 * see the preferences cached from the last visit (the same ones the bootstrap
 * script in index.html replayed), so pixel-sized consumers such as the
 * terminal do not jump once the saved values arrive.
 */
export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const { data: settings } = trpc.userSettings.get.useQuery();
  const [cached] = useState(() => readStoredAppearance()?.appearance ?? null);
  const appearance = useMemo(
    () => (settings ? appearanceFromUserSettings(settings) : null),
    [settings]
  );

  useEffect(() => {
    if (!appearance) {
      return;
    }
    writeStoredAppearance(applyAppearance(appearance));
  }, [appearance]);

  return (
    <AppearanceContext.Provider value={appearance ?? cached ?? DEFAULT_APPEARANCE}>
      {children}
    </AppearanceContext.Provider>
  );
}

/** Current appearance preferences; defaults outside an AppearanceProvider. */
export function useAppearance(): AppearanceSettings {
  return useContext(AppearanceContext);
}
