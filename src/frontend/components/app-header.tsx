import { useAppNavigationData } from '@/frontend/hooks/use-app-navigation-data';
import { useAppHeaderContext } from './app-header-context';
import { HamburgerMenu } from './hamburger-menu';

export function AppHeader() {
  const { title, setRightSlot, setLeftExtraSlot } = useAppHeaderContext();
  const navData = useAppNavigationData();

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-2 min-h-12 pt-[env(safe-area-inset-top)]">
      <HamburgerMenu navData={navData} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
        <div ref={setLeftExtraSlot} className="flex shrink-0 items-center gap-1" />
      </div>
      <div ref={setRightSlot} className="ml-auto flex shrink-0 items-center gap-1" />
    </header>
  );
}
