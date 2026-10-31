import { TabsList, TabsTrigger } from '@/components/ui/tabs';

export function SettingsTabsList() {
  return (
    <div className="min-w-0 overflow-x-auto">
      <TabsList aria-label="Settings" className="w-max min-w-full sm:min-w-0">
        <TabsTrigger value="general" className="flex-1 shrink-0 sm:flex-initial">
          General Settings
        </TabsTrigger>
        <TabsTrigger value="appearance" className="flex-1 shrink-0 sm:flex-initial">
          Appearance
        </TabsTrigger>
        <TabsTrigger value="project" className="flex-1 shrink-0 sm:flex-initial">
          Project Settings
        </TabsTrigger>
        <TabsTrigger value="voice" className="flex-1 shrink-0 sm:flex-initial">
          Voice Mode
        </TabsTrigger>
      </TabsList>
    </div>
  );
}
