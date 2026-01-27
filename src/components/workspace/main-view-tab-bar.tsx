'use client';

import { FileCode, FileDiff, MessageSquare, Plus, X } from 'lucide-react';
import { useCallback } from 'react';

import { cn } from '@/lib/utils';

import type { MainViewTab } from './workspace-panel-context';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getTabIcon(type: MainViewTab['type']) {
  switch (type) {
    case 'chat':
      return MessageSquare;
    case 'file':
      return FileCode;
    case 'diff':
      return FileDiff;
  }
}

// =============================================================================
// Sub-Components
// =============================================================================

interface BaseTabItemProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function BaseTabItem({ icon, label, isActive, onSelect, onClose }: BaseTabItemProps) {
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose?.();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    },
    [onSelect]
  );

  return (
    <div
      role="tab"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      aria-selected={isActive}
      className={cn(
        'group relative flex items-center gap-1.5 px-2 py-1 text-sm font-medium cursor-pointer',
        'rounded-md transition-all whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isActive
          ? 'bg-background text-foreground shadow-sm border border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      {icon}
      <span className="truncate max-w-[120px]">{label}</span>

      {onClose && (
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            'ml-1 rounded p-0.5 opacity-0 transition-opacity',
            'hover:bg-muted-foreground/20 focus-visible:opacity-100',
            'group-hover:opacity-100'
          )}
          aria-label={`Close ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

interface TabItemProps {
  tab: MainViewTab;
  isActive: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function TabItem({ tab, isActive, onSelect, onClose }: TabItemProps) {
  const Icon = getTabIcon(tab.type);
  return (
    <BaseTabItem
      icon={<Icon className="h-3.5 w-3.5 shrink-0" />}
      label={tab.label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

// =============================================================================
// Session Tab Item
// =============================================================================

interface SessionTabItemProps {
  label: string;
  isActive: boolean;
  isRunning?: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function SessionTabItem({ label, isActive, isRunning, onSelect, onClose }: SessionTabItemProps) {
  return (
    <BaseTabItem
      icon={
        <MessageSquare
          className={cn('h-3.5 w-3.5 shrink-0', isRunning && 'animate-pulse text-yellow-500')}
        />
      }
      label={label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

// =============================================================================
// Main Component
// =============================================================================

interface MainViewTabBarProps {
  className?: string;
  sessions?: Session[];
  currentSessionId?: string | null;
  runningSessionId?: string;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void;
  onCloseSession?: (sessionId: string) => void;
  disabled?: boolean;
}

export function MainViewTabBar({
  className,
  sessions,
  currentSessionId,
  runningSessionId,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  disabled,
}: MainViewTabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab } = useWorkspacePanel();

  // Filter out the default 'chat' tab since we're showing sessions instead
  const nonChatTabs = tabs.filter((tab) => tab.type !== 'chat');

  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-0.5 bg-muted/50 p-1 overflow-x-auto', className)}
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {/* Session tabs (Chat 1, Chat 2, etc.) */}
      {sessions?.map((session, index) => (
        <SessionTabItem
          key={session.id}
          label={`Chat ${index + 1}`}
          isActive={session.id === currentSessionId && activeTabId === 'chat'}
          isRunning={session.id === runningSessionId}
          onSelect={() => {
            onSelectSession?.(session.id);
            selectTab('chat');
          }}
          onClose={sessions.length > 1 ? () => onCloseSession?.(session.id) : undefined}
        />
      ))}

      {/* Add session button */}
      {onCreateSession && (
        <button
          type="button"
          onClick={onCreateSession}
          disabled={disabled}
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded-md',
            'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            'transition-colors disabled:opacity-50 disabled:pointer-events-none'
          )}
          aria-label="New chat session"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Separator between sessions and file tabs */}
      {nonChatTabs.length > 0 && <div className="h-4 w-px bg-border mx-1" />}

      {/* File/diff tabs */}
      {nonChatTabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onSelect={() => selectTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}
