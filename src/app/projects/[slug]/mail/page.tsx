'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '../../../../frontend/lib/trpc';

type MailFilter = { type: 'all' } | { type: 'human' } | { type: 'agent'; agentId: string };

export default function ProjectMailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [showComposeModal, setShowComposeModal] = useState(false);
  const [filter, setFilter] = useState<MailFilter>({ type: 'human' });

  // Get project for filtering
  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  // Fetch agents for filter dropdown (scoped to project via context header)
  const { data: agents } = trpc.agent.list.useQuery({}, { enabled: !!project?.id });

  // Conditional mail queries based on filter - all scoped to project via context header
  const allMailQuery = trpc.mail.listAll.useQuery(
    { includeRead: true },
    { enabled: filter.type === 'all' && !!project?.id, refetchInterval: 5000 }
  );

  const humanMailQuery = trpc.mail.listHumanInbox.useQuery(
    { includeRead: true },
    { enabled: filter.type === 'human' && !!project?.id, refetchInterval: 5000 }
  );

  const agentMailQuery = trpc.mail.listAgentInbox.useQuery(
    { agentId: filter.type === 'agent' ? filter.agentId : '', includeRead: true },
    { enabled: filter.type === 'agent', refetchInterval: 5000 }
  );

  // Determine which data to use based on filter
  const mail =
    filter.type === 'all'
      ? allMailQuery.data
      : filter.type === 'human'
        ? humanMailQuery.data
        : agentMailQuery.data;

  const isLoading =
    filter.type === 'all'
      ? allMailQuery.isLoading
      : filter.type === 'human'
        ? humanMailQuery.isLoading
        : agentMailQuery.isLoading;

  const refetch =
    filter.type === 'all'
      ? allMailQuery.refetch
      : filter.type === 'human'
        ? humanMailQuery.refetch
        : agentMailQuery.refetch;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading mail...</div>
      </div>
    );
  }

  const unreadCount = mail?.filter((m) => !m.isRead).length ?? 0;
  const selectedAgent =
    filter.type === 'agent' ? agents?.find((a) => a.id === filter.agentId) : null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {filter.type === 'all'
              ? 'All System Mail'
              : filter.type === 'human'
                ? 'Mail Inbox'
                : `Agent Inbox`}
          </h1>
          <p className="text-gray-600 mt-1">
            {filter.type === 'all'
              ? 'All mail in the system'
              : filter.type === 'human'
                ? 'Communication from agents'
                : `Mail for ${selectedAgent?.type || 'agent'}`}
            {unreadCount > 0 && <span className="ml-2 text-blue-600">({unreadCount} unread)</span>}
          </p>
        </div>
        <button
          onClick={() => setShowComposeModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          Compose
        </button>
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex gap-4 items-center flex-wrap">
          <label className="text-sm font-medium text-gray-700">View:</label>

          {/* Quick filter buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => setFilter({ type: 'human' })}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter.type === 'human'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              My Inbox
            </button>
            <button
              onClick={() => setFilter({ type: 'all' })}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter.type === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All Mail
            </button>
          </div>

          {/* Agent dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">or</span>
            <select
              value={filter.type === 'agent' ? filter.agentId : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setFilter({ type: 'agent', agentId: e.target.value });
                }
              }}
              className="border rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="">Select agent inbox...</option>
              {agents?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.type} - {agent.id.slice(0, 8)}...
                </option>
              ))}
            </select>
          </div>

          {/* Clear filter (show when viewing agent) */}
          {filter.type === 'agent' && (
            <button
              onClick={() => setFilter({ type: 'human' })}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Mail List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!mail || mail.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <svg
              className="w-12 h-12 mx-auto text-gray-300 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
              />
            </svg>
            <p>Your inbox is empty</p>
            <p className="text-sm mt-2">Messages from agents will appear here</p>
          </div>
        ) : (
          <div className="divide-y">
            {mail.map((item) => (
              <Link
                key={item.id}
                href={`/projects/${slug}/mail/${item.id}`}
                className={`block p-4 hover:bg-gray-50 ${!item.isRead ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {!item.isRead && (
                        <span className="w-2 h-2 bg-blue-600 rounded-full flex-shrink-0" />
                      )}
                      <p
                        className={`text-sm truncate ${!item.isRead ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                      >
                        {item.subject}
                      </p>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      <MailParticipants
                        item={item as MailWithRelations}
                        showRecipient={filter.type === 'all'}
                      />
                    </p>
                    <p className="text-sm text-gray-400 truncate mt-1">
                      {item.body.slice(0, 100)}...
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0 ml-4">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Compose Modal */}
      {showComposeModal && (
        <ComposeModal
          onClose={() => setShowComposeModal(false)}
          onSent={() => {
            setShowComposeModal(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

// Type for mail items with relations
type MailWithRelations = {
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  isForHuman: boolean;
  fromAgent?: { type: string; id: string } | null;
  toAgent?: { type: string; id: string } | null;
};

function MailParticipants({
  item,
  showRecipient,
}: {
  item: MailWithRelations;
  showRecipient: boolean;
}) {
  return (
    <>
      From:{' '}
      {item.fromAgent ? (
        <>
          {item.fromAgent.type}{' '}
          <span className="font-mono text-xs">({item.fromAgent.id.slice(0, 8)}...)</span>
        </>
      ) : (
        'Human'
      )}
      {showRecipient && (
        <>
          {' '}
          <span className="text-gray-400">→</span>{' '}
          {item.isForHuman ? (
            'Human'
          ) : item.toAgent ? (
            <>
              {item.toAgent.type}{' '}
              <span className="font-mono text-xs">({item.toAgent.id.slice(0, 8)}...)</span>
            </>
          ) : (
            'Unknown'
          )}
        </>
      )}
    </>
  );
}

function ComposeModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [toAgentId, setToAgentId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  // Agents are scoped to project via context header
  const { data: agents } = trpc.agent.list.useQuery({});

  const sendMail = trpc.mail.sendToAgent.useMutation({
    onSuccess: () => {
      onSent();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!toAgentId) {
      setError('Please select an agent');
      return;
    }
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    if (!body.trim()) {
      setError('Message body is required');
      return;
    }

    sendMail.mutate({ toAgentId, subject, body });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Compose Message</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To (Agent)</label>
            <select
              value={toAgentId}
              onChange={(e) => setToAgentId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="">Select an agent...</option>
              {agents?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.type} - {agent.id.slice(0, 8)}... ({agent.state})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="Message subject"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="Your message to the agent..."
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sendMail.isPending}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {sendMail.isPending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
