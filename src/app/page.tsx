'use client';

import Link from 'next/link';
import { trpc } from '../frontend/lib/trpc';

function StatCard({
  title,
  value,
  color,
  href,
}: {
  title: string;
  value: number | string;
  color: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={`block p-6 rounded-lg shadow-sm hover:shadow-md transition-shadow ${color}`}
    >
      <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </Link>
  );
}

function EpicStateBreakdown({ byState }: { byState: Record<string, number> }) {
  const stateColors: Record<string, string> = {
    PLANNING: 'bg-gray-100 text-gray-800',
    IN_PROGRESS: 'bg-blue-100 text-blue-800',
    BLOCKED: 'bg-red-100 text-red-800',
    COMPLETED: 'bg-green-100 text-green-800',
    CANCELLED: 'bg-gray-100 text-gray-500',
  };

  return (
    <div className="flex gap-2 flex-wrap">
      {Object.entries(byState).map(([state, count]) => (
        <span key={state} className={`px-2 py-1 rounded text-xs font-medium ${stateColors[state]}`}>
          {state}: {count}
        </span>
      ))}
    </div>
  );
}

function TaskStateBreakdown({ byState }: { byState: Record<string, number> }) {
  const stateColors: Record<string, string> = {
    PENDING: 'bg-gray-100 text-gray-800',
    ASSIGNED: 'bg-yellow-100 text-yellow-800',
    IN_PROGRESS: 'bg-blue-100 text-blue-800',
    REVIEW: 'bg-purple-100 text-purple-800',
    BLOCKED: 'bg-red-100 text-red-800',
    COMPLETED: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
  };

  return (
    <div className="flex gap-2 flex-wrap">
      {Object.entries(byState).map(([state, count]) => (
        <span key={state} className={`px-2 py-1 rounded text-xs font-medium ${stateColors[state]}`}>
          {state}: {count}
        </span>
      ))}
    </div>
  );
}

function AgentHealthIndicator({ healthy, unhealthy }: { healthy: number; unhealthy: number }) {
  return (
    <div className="flex gap-4">
      <span className="flex items-center gap-1">
        <span className="w-3 h-3 rounded-full bg-green-500"></span>
        <span className="text-sm">Healthy: {healthy}</span>
      </span>
      <span className="flex items-center gap-1">
        <span className="w-3 h-3 rounded-full bg-red-500"></span>
        <span className="text-sm">Unhealthy: {unhealthy}</span>
      </span>
    </div>
  );
}

interface RecentItem {
  id: string;
}

function RecentItems<T extends RecentItem>({
  title,
  items,
  renderItem,
  href,
  emptyText,
}: {
  title: string;
  items: T[] | undefined;
  renderItem: (item: T) => React.ReactNode;
  href: string;
  emptyText: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-lg">{title}</h3>
        <Link href={href} className="text-blue-600 hover:text-blue-800 text-sm">
          View all
        </Link>
      </div>
      {!items || items.length === 0 ? (
        <p className="text-gray-500 text-sm">{emptyText}</p>
      ) : (
        <ul className="space-y-3">{items.slice(0, 5).map((item) => renderItem(item))}</ul>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { data: epicStats, isLoading: epicLoading } = trpc.epic.getStats.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: taskStats, isLoading: taskLoading } = trpc.task.getStats.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: agentStats, isLoading: agentLoading } = trpc.agent.getStats.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: unreadCount } = trpc.mail.getUnreadCount.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const { data: recentEpics } = trpc.epic.list.useQuery({ limit: 5 }, { refetchInterval: 5000 });
  const { data: recentTasks } = trpc.task.list.useQuery({ limit: 5 }, { refetchInterval: 5000 });
  const { data: recentMail } = trpc.mail.listHumanInbox.useQuery(
    { includeRead: true },
    { refetchInterval: 5000 }
  );

  const isLoading = epicLoading || taskLoading || agentLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">Overview of your autonomous development system</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Epics"
          value={epicStats?.total ?? 0}
          color="bg-white"
          href="/epics"
        />
        <StatCard
          title="Total Tasks"
          value={taskStats?.total ?? 0}
          color="bg-white"
          href="/tasks"
        />
        <StatCard
          title="Active Agents"
          value={agentStats?.total ?? 0}
          color="bg-white"
          href="/agents"
        />
        <StatCard
          title="Unread Mail"
          value={unreadCount?.count ?? 0}
          color={unreadCount?.count ? 'bg-yellow-50' : 'bg-white'}
          href="/mail"
        />
      </div>

      {/* Status Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h3 className="font-semibold mb-3">Epic Status</h3>
          {epicStats?.byState && <EpicStateBreakdown byState={epicStats.byState} />}
        </div>
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h3 className="font-semibold mb-3">Task Status</h3>
          {taskStats?.byState && <TaskStateBreakdown byState={taskStats.byState} />}
        </div>
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h3 className="font-semibold mb-3">Agent Health</h3>
          {agentStats && (
            <AgentHealthIndicator healthy={agentStats.healthy} unhealthy={agentStats.unhealthy} />
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="font-semibold mb-4">Quick Actions</h3>
        <div className="flex gap-4">
          <Link
            href="/epics/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Epic
          </Link>
          <Link
            href="/agents"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
              />
            </svg>
            View Agents
          </Link>
          <Link
            href="/mail"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Check Mail
          </Link>
        </div>
      </div>

      {/* Recent Items */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <RecentItems
          title="Recent Epics"
          items={recentEpics}
          href="/epics"
          emptyText="No epics yet"
          renderItem={(epic) => (
            <li key={epic.id}>
              <Link
                href={`/epics/${epic.id}`}
                className="block hover:bg-gray-50 -mx-2 px-2 py-2 rounded"
              >
                <p className="font-medium text-sm truncate">{epic.title}</p>
                <p className="text-xs text-gray-500">{epic.state}</p>
              </Link>
            </li>
          )}
        />
        <RecentItems
          title="Recent Tasks"
          items={recentTasks}
          href="/tasks"
          emptyText="No tasks yet"
          renderItem={(task) => (
            <li key={task.id}>
              <Link
                href={`/tasks/${task.id}`}
                className="block hover:bg-gray-50 -mx-2 px-2 py-2 rounded"
              >
                <p className="font-medium text-sm truncate">{task.title}</p>
                <p className="text-xs text-gray-500">{task.state}</p>
              </Link>
            </li>
          )}
        />
        <RecentItems
          title="Recent Mail"
          items={recentMail?.slice(0, 5)}
          href="/mail"
          emptyText="No mail yet"
          renderItem={(mail) => (
            <li key={mail.id}>
              <Link
                href={`/mail/${mail.id}`}
                className={`block hover:bg-gray-50 -mx-2 px-2 py-2 rounded ${!mail.isRead ? 'font-semibold' : ''}`}
              >
                <p className="text-sm truncate">{mail.subject}</p>
                <p className="text-xs text-gray-500">From: {(mail as { fromAgent?: { type: string } }).fromAgent?.type || 'Human'}</p>
              </Link>
            </li>
          )}
        />
      </div>
    </div>
  );
}
