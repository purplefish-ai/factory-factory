import { useAppNavigationData } from '@/frontend/hooks/use-app-navigation-data';
import { useAppHeaderContext } from './app-header-context';
import { HamburgerMenu } from './hamburger-menu';

export function AppHeader() {
  const { title, setRightSlot, setLeftExtraSlot } = useAppHeaderContext();
  const navData = useAppNavigationData();

  return (
    <header className="flex shrink-0 items-center gap-2 border-b bg-background px-2 h-12 pt-[env(safe-area-inset-top)]">
      <HamburgerMenu navData={navData} />
      <span className="text-sm font-semibold truncate">{title}</span>
      <div ref={setLeftExtraSlot} className="flex items-center gap-1" />
      <div ref={setRightSlot} className="ml-auto flex items-center gap-1 shrink-0" />
    </header>
  );
}
