import { createContext, useContext, useEffect, useMemo } from 'react';
import { applyAppearance, writeStoredAppearance } from '@/client/lib/appearance';
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
 * see the defaults and the document keeps whatever the bootstrap script in
 * index.html replayed from the last visit.
 */
export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const { data: settings } = trpc.userSettings.get.useQuery();
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
    <AppearanceContext.Provider value={appearance ?? DEFAULT_APPEARANCE}>
      {children}
    </AppearanceContext.Provider>
  );
}

/** Current appearance preferences; defaults outside an AppearanceProvider. */
export function useAppearance(): AppearanceSettings {
  return useContext(AppearanceContext);
}
